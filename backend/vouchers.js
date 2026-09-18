// Core "one voucher, one device" rule lives here:
// - unused  -> binds to whichever device redeems it first, then provisions it
// - active  -> only the MAC it's already bound to may redeem it again
//              (e.g. reconnecting); any other device is rejected outright
// - expired / blocked -> always rejected
//
// Returns a status string rather than a plain ok/fail boolean so the
// route layer can tell the client *why* — specifically so an expired
// code can say "expired" instead of just "invalid", per operator policy.
const supabase = require('../supabaseClient');
const devices = require('./devices');
const mikrotik = require('./mikrotik');
const { randomCode } = require('../utils/codes');
const DURATION_MS = require('../utils/durations');

async function redeem(code, mac) {
  const { data: voucher } = await supabase
    .from('vouchers')
    .select('*, plans(*)')
    .eq('code', code)
    .maybeSingle();

  if (!voucher) {
    await devices.recordGuess(mac, false);
    return { status: 'not_found' };
  }

  if (voucher.status === 'blocked') {
    await devices.recordGuess(mac, false);
    return { status: 'blocked' };
  }

  if (voucher.status === 'expired') {
    return { status: 'expired' };
  }

  if (voucher.status === 'active') {
    if (voucher.mac !== mac) {
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

    // Time's up but nobody marked the voucher expired yet — do it now so
    // it shows correctly on the admin console too.
    await supabase.from('vouchers').update({ status: 'expired' }).eq('code', code);
    return { status: 'expired' };
  }

  // status === 'unused' -> bind it to this device now.
  const plan = voucher.plans;
  const ms = plan && DURATION_MS[plan.duration] ? DURATION_MS[plan.duration] : 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ms).toISOString();
  const password = randomCode('', 8);
  const username = mac.replace(/:/g, '');

  await mikrotik.provisionUser({
    mac,
    username,
    password,
    rateLimitMbps: plan ? plan.speed_mbps : undefined,
  });

  await supabase.from('vouchers').update({ status: 'active', mac }).eq('code', code);

  await supabase.from('sessions').insert({
    mac,
    plan_id: plan ? plan.id : null,
    started_at: new Date().toISOString(),
    expires_at: expiresAt,
    status: 'active',
    hotspot_password: password,
    speed_mbps: plan ? plan.speed_mbps : null,
  });

  await supabase.from('devices').upsert({
    mac,
    status: 'online',
    guesses: 0,
    last_seen: new Date().toISOString(),
  });

  await supabase.from('logs').insert({
    event: 'Voucher redeemed',
    actor: 'system',
    detail: code + ' bound to ' + mac,
  });

  return { status: 'ok', expiresAt };
}

module.exports = { redeem };
