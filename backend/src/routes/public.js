// These five endpoints are the ones marnet-portal.html already calls.
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
    const { phone, plan, amount, device } = req.body || {};

    if (!phone || !/^0[71]\d{8}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid Safaricom number' });
    }
    if (!plan || !amount) {
      return res.status(400).json({ error: 'Missing plan details' });
    }

    const mac = device && device.mac ? String(device.mac).toUpperCase() : null;

    // Best-effort match to a real plan row, so we know its speed cap and
    // duration later. Not fatal if it doesn't match — plan/amount from the
    // request still drive the STK push either way.
    const { data: planRow } = await supabase
      .from('plans')
      .select('*')
      .ilike('duration', plan)
      .eq('price', amount)
      .maybeSingle();

    const mpesaRes = await mpesa.stkPush({
      phone,
      amount,
      accountReference: 'MARNET',
      description: plan + ' WiFi bundle',
    });

    if (!mpesaRes.CheckoutRequestID) {
      throw new Error('Daraja did not return a CheckoutRequestID');
    }

    await supabase.from('payments').insert({
      checkout_request_id: mpesaRes.CheckoutRequestID,
      phone,
      plan_id: planRow ? planRow.id : null,
      plan_label: plan,
      amount,
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

    // Belt-and-braces: if the router doesn't currently show this MAC as
    // active (e.g. it rebooted), re-provision it rather than trusting our
    // own database alone.
    const online = await mikrotik.isOnline(mac).catch(() => true);
    if (!online) {
      await mikrotik.provisionUser({
        mac,
        username: mac.replace(/:/g, ''),
        password: session.hotspot_password || randomCode('', 8),
        rateLimitMbps: session.speed_mbps,
      }).catch(() => {});
    }

    res.json({ ok: true });
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

    // Admin-minted vouchers are always "MN" + 6 chars; anything else is
    // treated as a pasted M-Pesa transaction code (e.g. "UIGL56IRMO").
    const cleanCode = String(code).trim().toUpperCase();
    const result = cleanCode.startsWith('MN')
      ? await vouchers.redeem(cleanCode, mac)
      : await mpesaReceipts.redeem(cleanCode, mac);

    res.json(toRedeemResponse(result));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
