// Safaricom calls this URL directly (see MPESA_CALLBACK_URL) once a
// payment is confirmed or fails — it does not go through either frontend.
// This is the ONLY place a payment is ever marked confirmed; the client
// portal just polls /api/status/:id and waits for that to happen here.
const express = require('express');
const supabase = require('../supabaseClient');
const mikrotik = require('../services/mikrotik');
const { randomCode } = require('../utils/codes');
const DURATION_MS = require('../utils/durations');

const router = express.Router();

router.post('/callback', async (req, res) => {
  // Acknowledge immediately — Safaricom retries on anything but a prompt
  // 200, and provisioning can take a few seconds we don't want to make
  // them wait through.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const stk = req.body && req.body.Body && req.body.Body.stkCallback;
    if (!stk) return;

    const { data: payment } = await supabase
      .from('payments')
      .select('*')
      .eq('checkout_request_id', stk.CheckoutRequestID)
      .maybeSingle();
    if (!payment) return;

    if (stk.ResultCode !== 0) {
      await supabase.from('payments').update({ status: 'failed' }).eq('id', payment.id);
      await supabase.from('logs').insert({
        event: 'Payment failed',
        actor: 'system',
        detail: payment.phone + ' · ' + (payment.plan_label || '') + ' · ' + stk.ResultDesc,
      });
      return;
    }

    const items = (stk.CallbackMetadata && stk.CallbackMetadata.Item) || [];
    const get = (name) => {
      const item = items.find((i) => i.Name === name);
      return item ? item.Value : null;
    };
    const receipt = get('MpesaReceiptNumber');

    const plan = payment.plan_id
      ? (await supabase.from('plans').select('*').eq('id', payment.plan_id).maybeSingle()).data
      : null;

    const mac = payment.mac;
    const password = randomCode('', 8);
    const username = mac ? mac.replace(/:/g, '') : null;

    if (mac) {
      await mikrotik.provisionUser({
        mac,
        username,
        password,
        rateLimitMbps: plan ? plan.speed_mbps : undefined,
      });
    }

    const ms = plan && DURATION_MS[plan.duration] ? DURATION_MS[plan.duration] : 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + ms).toISOString();

    await supabase.from('payments').update({
      status: 'confirmed',
      mpesa_receipt: receipt,
      hotspot_username: username,
      hotspot_password: password,
    }).eq('id', payment.id);

    if (mac) {
      await supabase.from('sessions').insert({
        mac,
        plan_id: payment.plan_id,
        started_at: new Date().toISOString(),
        expires_at: expiresAt,
        status: 'active',
        hotspot_password: password,
        speed_mbps: plan ? plan.speed_mbps : null,
      });
      await supabase.from('devices').upsert({
        mac,
        status: 'online',
        last_seen: new Date().toISOString(),
      });
    }

    await supabase.from('logs').insert({
      event: 'Payment confirmed',
      actor: 'system',
      detail: payment.phone + ' · ' + (payment.plan_label || '') + ' · Ksh ' + payment.amount,
    });
  } catch (err) {
    // Safaricom already got its 200 above, so just log this — there's no
    // one left to respond to.
    console.error('[marnet] mpesa callback error', err);
  }
});

// --- C2B: "paste your M-Pesa code" flow, for payments made straight to
// the Till without going through the app at all. Registered once via
// POST /api/admin/mpesa/register-c2b (see services/mpesa.js). ---

// Safaricom calls this before Confirmation, asking whether to accept the
// payment at all. We don't reject anything here — the payment has
// already left the client's account by this point — we just record and
// let it through.
router.post('/c2b/validation', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// The actual "money has landed" notification. This is the ONLY place a
// pasted M-Pesa code becomes redeemable — nothing else populates
// mpesa_receipts.
router.post('/c2b/confirmation', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const body = req.body || {};
    const code = body.TransID;
    if (!code) return;

    const name = [body.FirstName, body.MiddleName, body.LastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    const amount = body.TransAmount != null ? Math.round(Number(body.TransAmount)) : null;

    await supabase.from('mpesa_receipts').upsert(
      {
        code,
        phone: body.MSISDN || null,
        customer_name: name || null,
        amount,
        used: false,
      },
      { onConflict: 'code' }
    );

    await supabase.from('logs').insert({
      event: 'M-Pesa payment received',
      actor: 'system',
      detail: (name || body.MSISDN || 'Unknown') + ' · Ksh ' + amount + ' · ' + code,
    });
  } catch (err) {
    console.error('[marnet] c2b confirmation error', err);
  }
});

module.exports = router;
