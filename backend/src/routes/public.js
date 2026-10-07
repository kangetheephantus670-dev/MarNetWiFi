// These endpoints are the ones the MarNet portal (login/index.html) calls.
// Nothing here requires login — anyone on the hotspot's network can reach
// these, which is the point, so every input is treated as untrusted.
const express = require('express');
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');
const mpesa = require('../services/mpesa');
const mikrotik = require('../services/mikrotik');
const vouchers = require('../services/vouchers');
const mpesaReceipts = require('../services/mpesaReceipts');
const devices = require('../services/devices');
const { randomCode } = require('../utils/codes');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

function getMac(req) {
  const mac = req.body && req.body.device && req.body.device.mac;
  return mac ? String(mac).toUpperCase() : null;
}

// The router polls for jobs every ~10s. Wait until it has picked up this
// device's "add user" job, then give it a moment to apply it, so the portal
// only says "connected" once the router really knows the user.
async function waitForRouter(mac, maxMs = 20000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const { data } = await supabase
      .from('router_jobs')
      .select('id')
      .eq('mac', mac)
      .eq('action', 'add')
      .eq('status', 'pending')
      .limit(1);
    if (!data || !data.length) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 3000));
}

// The plans the portal shows. Loaded live so admin changes appear at once.
router.get('/plans', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('id, duration, price, popular, devices_allowed, speed_mbps')
      .order('price', { ascending: true });
    if (error) throw error;
    res.json({ plans: data });
  } catch (err) {
    next(err);
  }
});

// Five STK push attempts per minute per IP is plenty for a real person
// buying a bundle, and slows down anyone trying to hammer the endpoint.
const stkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a moment and try again.' },
});

router.post('/stk-push', stkLimiter, async (req, res, next) => {
  try {
    const { phone, planId, plan, amount, device } = req.body || {};

    if (!phone || !/^0[71]\d{8}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid Safaricom number' });
    }

    const mac = device && device.mac ? String(device.mac).toUpperCase() : null;
    if (!mac) {
      return res.status(400).json({ error: 'We could not detect your device. Reconnect to the WiFi and try again.' });
    }

    // The price always comes from the plans table, never from the browser,
    // so nobody can pay less than a plan costs.
    let planRow = null;
    if (planId) {
      const { data } = await supabase.from('plans').select('*').eq('id', planId).maybeSingle();
      planRow = data;
    } else if (plan && amount) {
      const { data } = await supabase
        .from('plans')
        .select('*')
        .ilike('duration', plan)
        .eq('price', amount)
        .maybeSingle();
      planRow = data;
    }
    if (!planRow) {
      return res.status(400).json({ error: 'That plan is no longer available. Refresh the page and try again.' });
    }

    const mpesaRes = await mpesa.stkPush({
      phone,
      amount: planRow.price,
      accountReference: 'MARNET',
      description: planRow.duration + ' WiFi bundle',
    });

    if (!mpesaRes.CheckoutRequestID) {
      throw new Error('Daraja did not return a CheckoutRequestID');
    }

    await supabase.from('payments').insert({
      checkout_request_id: mpesaRes.CheckoutRequestID,
      phone,
      plan_id: planRow.id,
      plan_label: planRow.duration,
      amount: planRow.price,
      mac,
      status: 'pending',
    });

    res.json({ checkoutRequestId: mpesaRes.CheckoutRequestID });
  } catch (err) {
    next(err);
  }
});

router.get('/status/:id', async (req, res, next) => {
  try {
    const { data: payment } = await supabase
      .from('payments')
      .select('*')
      .eq('checkout_request_id', req.params.id)
      .maybeSingle();

    if (!payment) return res.json({ status: 'queued' });

    if (payment.status === 'confirmed' && payment.hotspot_username) {
      if (payment.mac) {
        const { data: pend } = await supabase
          .from('router_jobs')
          .select('id')
          .eq('mac', payment.mac)
          .eq('action', 'add')
          .eq('status', 'pending')
          .limit(1);
        if (pend && pend.length) return res.json({ status: 'queued' });
      }
      return res.json({
        status: 'provisioned',
        hotspotUsername: payment.hotspot_username,
        hotspotPassword: payment.hotspot_password,
      });
    }
    if (payment.status === 'failed') return res.json({ status: 'failed' });

    return res.json({ status: 'queued' });
  } catch (err) {
    next(err);
  }
});

router.post('/reconnect', async (req, res, next) => {
  try {
    const mac = getMac(req);
    if (!mac) return res.json({ ok: false });

    const { data: session } = await supabase
      .from('sessions')
      .select('*')
      .eq('mac', mac)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false })
      .maybeSingle();

    if (!session) return res.json({ ok: false });

    // Always re-queue the router user (it may have been removed or the
    // router may have rebooted), wait for the router to apply it, then hand
    // the portal the login details.
    const username = mac.replace(/:/g, '');
    const password = session.hotspot_password || randomCode('', 8);
    await mikrotik.provisionUser({
      mac,
      username,
      password,
      rateLimitMbps: session.speed_mbps,
    }).catch(() => {});
    await waitForRouter(mac);

    res.json({ ok: true, hotspotUsername: username, hotspotPassword: password });
  } catch (err) {
    next(err);
  }
});

// Turns an internal redeem status into the response the client-facing
// portal shows, per operator policy: say plainly when a code has expired
// (rather than lumping it in with "invalid"), and hand back how much
// time is left on success so the portal can display it.
function toRedeemResponse(result) {
  switch (result.status) {
    case 'ok': {
      const remainingMinutes = result.expiresAt
        ? Math.max(0, Math.round((new Date(result.expiresAt).getTime() - Date.now()) / 60000))
        : null;
      return { ok: true, message: 'Code accepted. Connecting your device…', remainingMinutes, expiresAt: result.expiresAt };
    }
    case 'expired':
      return { ok: false, expired: true, message: "That code has expired." };
    case 'wrong_device':
      return { ok: false, message: 'That code is already in use on another device.' };
    case 'no_matching_plan':
      return { ok: false, message: "We couldn't match that payment to a package. Please contact us." };
    case 'blocked':
      return { ok: false, message: "That code isn't valid." };
    case 'not_found':
    default:
      return { ok: false, message: "We couldn't find that code. Check it and try again." };
  }
}

router.post('/voucher/redeem', async (req, res, next) => {
  try {
    const { code } = req.body || {};
    const mac = getMac(req);
    if (!code || !mac) return res.json({ ok: false, message: 'Missing code or device.' });

    const blocked = await devices.isBlocked(mac);
    if (blocked) {
      return res.json({ ok: false, message: 'Too many attempts. Please contact us for help.' });
    }

    // Accept a bare code OR a whole pasted M-Pesa SMS: pull the code out of it.
    const raw = String(code).toUpperCase();
    const found = raw.match(/\bMN[A-Z0-9]{6}\b/) || raw.match(/\b[A-Z0-9]{10}\b/);
    const cleanCode = found ? found[0] : raw.replace(/\s+/g, '').slice(0, 20);
    // Admin vouchers are exactly "MN" + 6 characters; M-Pesa codes are 10
    // (e.g. "UIGL56IRMO") and can start with any letters, including MN.
    const isVoucher = /^MN[A-Z0-9]{6}$/.test(cleanCode);
    const result = isVoucher
      ? await vouchers.redeem(cleanCode, mac)
      : await mpesaReceipts.redeem(cleanCode, mac);

    const response = toRedeemResponse(result);
    if (response.ok) {
      await waitForRouter(mac);
      const { data: s } = await supabase
        .from('sessions')
        .select('hotspot_password')
        .eq('mac', mac)
        .eq('status', 'active')
        .order('expires_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (s) {
        response.hotspotUsername = mac.replace(/:/g, '');
        response.hotspotPassword = s.hotspot_password;
      }
    }
    res.json(response);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
