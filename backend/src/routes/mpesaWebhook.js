// Safaricom calls this URL directly (see MPESA_CALLBACK_URL) once a
// payment is confirmed or fails — it does not go through either frontend.
// Payments are confirmed here, or by the background sweep in
// services/payments.js if this callback never arrives.
const express = require('express');
const supabase = require('../supabaseClient');
const payments = require('../services/payments');

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
    if (!payment) {
      console.error('[marnet] callback for unknown CheckoutRequestID', stk.CheckoutRequestID);
      return;
    }

    if (stk.ResultCode !== 0) {
      await payments.failPayment(payment, stk.ResultDesc);
      return;
    }

    const items = (stk.CallbackMetadata && stk.CallbackMetadata.Item) || [];
    const item = items.find((i) => i.Name === 'MpesaReceiptNumber');
    await payments.confirmPayment(payment, item ? item.Value : null);
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
