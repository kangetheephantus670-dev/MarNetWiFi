
const express = require('express');
const supabase = require('../supabaseClient');
const payments = require('../services/payments');

const router = express.Router();

router.post('/callback', async (req, res) => {
  
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
    
    console.error('[marnet] mpesa callback error', err);
  }
});


router.post('/c2b/validation', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});


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
