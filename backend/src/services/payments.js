// Shared payment logic. Used by the Safaricom callback AND by the
// background sweep that asks Safaricom directly about pending payments,
// so a payment gets confirmed even if the callback never reaches us.
const supabase = require('../supabaseClient');
const mikrotik = require('./mikrotik');
const mpesa = require('./mpesa');
const { randomCode } = require('../utils/codes');
const DURATION_MS = require('../utils/durations');

// Marks a payment confirmed and provisions the customer. Safe to call twice
// (callback + sweep racing): only the first call to claim the row does the work.
async function confirmPayment(payment, receipt) {
  const plan = payment.plan_id
    ? (await supabase.from('plans').select('*').eq('id', payment.plan_id).maybeSingle()).data
    : null;

  const mac = payment.mac;
  const password = randomCode('', 8);
  const username = mac ? mac.replace(/:/g, '') : null;

  const update = {
    status: 'confirmed',
    hotspot_username: username,
    hotspot_password: password,
  };
  if (receipt) update.mpesa_receipt = receipt;

  // Claim the payment atomically: only a pending (or wrongly-failed) row wins.
  const { data: claimed } = await supabase
    .from('payments')
    .update(update)
    .eq('id', payment.id)
    .in('status', ['pending', 'failed'])
    .select('id');
  if (!claimed || !claimed.length) return false;

  if (mac) {
    try {
      await mikrotik.provisionUser({
        mac,
        username,
        password,
        rateLimitMbps: plan ? plan.speed_mbps : undefined,
      });
    } catch (err) {
      // Payment is already recorded; /reconnect re-queues the router user
      // from the session below, so don't abandon the customer here.
      console.error('[marnet] provisionUser failed for', mac, err);
    }

    const ms = plan && DURATION_MS[plan.duration] ? DURATION_MS[plan.duration] : 60 * 60 * 1000;
    await supabase.from('sessions').insert({
      mac,
      plan_id: payment.plan_id,
      phone: payment.phone || null,
      started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + ms).toISOString(),
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
  return true;
}

async function failPayment(payment, reason) {
  const { data: claimed } = await supabase
    .from('payments')
    .update({ status: 'failed' })
    .eq('id', payment.id)
    .eq('status', 'pending')
    .select('id');
  if (!claimed || !claimed.length) return false;

  await supabase.from('logs').insert({
    event: 'Payment failed',
    actor: 'system',
    detail: payment.phone + ' · ' + (payment.plan_label || '') + ' · ' + (reason || ''),
  });
  return true;
}

// Asks Safaricom about payments still pending (older than 20s, younger
// than 30 min) and settles them. Older ones are left alone on purpose:
// confirming a payment hours late would start a fresh session now.
let sweeping = false;
async function sweepPending() {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    const { data } = await supabase
      .from('payments')
      .select('*')
      .eq('status', 'pending')
      .gte('created_at', new Date(now - 30 * 60 * 1000).toISOString())
      .lte('created_at', new Date(now - 20 * 1000).toISOString())
      .limit(10);

    for (const p of data || []) {
      try {
        const r = await mpesa.stkQuery(p.checkout_request_id);
        if (!r.done) continue; // customer hasn't finished yet
        if (r.resultCode === 0) {
          console.log('[marnet] sweep confirmed', p.checkout_request_id);
          await confirmPayment(p, null);
        } else {
          console.log('[marnet] sweep failed', p.checkout_request_id, r.desc);
          await failPayment(p, r.desc);
        }
      } catch (err) {
        console.error('[marnet] sweep error for', p.checkout_request_id, err.message);
      }
    }
  } catch (err) {
    console.error('[marnet] sweepPending error', err);
  } finally {
    sweeping = false;
  }
}

module.exports = { confirmPayment, failPayment, sweepPending };
