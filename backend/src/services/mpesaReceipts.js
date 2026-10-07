// Handles the "paste your M-Pesa code" flow: the client pays the Till
// directly (no STK push, no app involvement), Safaricom's C2B
// confirmation lands in mpesa_receipts (see routes/mpesaWebhook.js), and
// the client redeems that same receipt code here — mirroring vouchers.js
// one-code-one-device rule, but matched by amount to a plan instead of
// carrying a plan_id from the start.
//
// Codes from payments made through the portal's STK push live in the
// payments table instead; redeemStkPayment() below handles those so the
// same pasted code works whichever way the customer paid.
const supabase = require('../supabaseClient');
const devices = require('./devices');
const mikrotik = require('./mikrotik');
const { randomCode } = require('../utils/codes');
const DURATION_MS = require('../utils/durations');

// A code from an STK-push payment: the plan was already provisioned when
// the payment was confirmed, so this just reconnects the device it was
// bought for. Returns null when the code isn't an STK payment at all.
async function redeemStkPayment(code, mac) {
  const { data: payment } = await supabase
    .from('payments')
    .select('*')
    .eq('mpesa_receipt', code)
    .eq('status', 'confirmed')
    .maybeSingle();
  if (!payment) return null;

  if (payment.mac && String(payment.mac).toUpperCase() !== mac) {
    await devices.recordGuess(mac, false);
    return { status: 'wrong_device' };
  }

  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('mac', mac)
    .eq('status', 'active')
    .order('expires_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (session && new Date(session.expires_at) > new Date()) {
    // Re-queue the router user in case it was removed (e.g. after Disconnect).
    await mikrotik.provisionUser({
      mac,
      username: mac.replace(/:/g, ''),
      password: session.hotspot_password,
      rateLimitMbps: session.speed_mbps,
    }).catch(() => {});
    await devices.recordGuess(mac, true);
    return { status: 'ok', expiresAt: session.expires_at };
  }
  return { status: 'expired' };
}

async function redeem(code, mac) {
  const { data: receipt } = await supabase
    .from('mpesa_receipts')
    .select('*')
    .eq('code', code)
    .maybeSingle();

  if (!receipt) {
    const fromStk = await redeemStkPayment(code, mac);
    if (fromStk) return fromStk;
    await devices.recordGuess(mac, false);
    return { status: 'not_found' };
  }

  if (receipt.used) {
    // Already redeemed — only the device it's bound to may use it again
    // (e.g. reconnecting after the router rebooted).
    if (receipt.mac !== mac) {
      await devices.recordGuess(mac, false);
      return { status: 'wrong_device' };
    }
    const { data: session } = await supabase
      .from('sessions')
      .select('*')
      .eq('mac', mac)
      .eq('status', 'active')
      .order('expires_at', { ascending: false })
      .maybeSingle();

    if (session && new Date(session.expires_at) > new Date()) {
      await devices.recordGuess(mac, true);
      return { status: 'ok', expiresAt: session.expires_at };
    }
    return { status: 'expired' };
  }

  // Not used yet — figure out which plan this payment matches by amount,
  // since a C2B payment carries no plan reference of its own.
  const { data: plan } = await supabase
    .from('plans')
    .select('*')
    .eq('price', receipt.amount)
    .maybeSingle();

  if (!plan) {
    return { status: 'no_matching_plan' };
  }

  const ms = DURATION_MS[plan.duration] || 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ms).toISOString();
  const password = randomCode('', 8);
  const username = mac.replace(/:/g, '');

  await mikrotik.provisionUser({
    mac,
    username,
    password,
    rateLimitMbps: plan.speed_mbps,
  });

  await supabase
    .from('mpesa_receipts')
    .update({ used: true, mac, plan_id: plan.id })
    .eq('code', code);

  await supabase.from('sessions').insert({
    mac,
    plan_id: plan.id,
    phone: receipt.phone,
    customer_name: receipt.customer_name,
    started_at: new Date().toISOString(),
    expires_at: expiresAt,
    status: 'active',
    hotspot_password: password,
    speed_mbps: plan.speed_mbps,
  });

  await supabase.from('devices').upsert({
    mac,
    status: 'online',
    guesses: 0,
    last_seen: new Date().toISOString(),
  });

  await supabase.from('logs').insert({
    event: 'M-Pesa code redeemed',
    actor: 'system',
    detail: code + ' (' + (receipt.customer_name || receipt.phone || 'unknown') + ') bound to ' + mac,
  });

  return { status: 'ok', expiresAt };
}

module.exports = { redeem };
