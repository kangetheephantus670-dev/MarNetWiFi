// Server-side enforcement of the voucher guess limit. The frontend already
// shows a countdown of attempts left, but that's just UX — this is what
// actually stops someone from brute-forcing a code, since it can't be
// bypassed by editing the page.
const supabase = require('../supabaseClient');

const MAX_GUESSES = 10;

async function isBlocked(mac) {
  const { data } = await supabase
    .from('devices')
    .select('status')
    .eq('mac', mac)
    .maybeSingle();
  return !!data && data.status === 'blocked';
}

async function recordGuess(mac, valid) {
  const { data: existing } = await supabase
    .from('devices')
    .select('*')
    .eq('mac', mac)
    .maybeSingle();

  const guesses = valid ? 0 : (existing ? existing.guesses + 1 : 1);
  const willBlock = !valid && guesses >= MAX_GUESSES;
  const status = willBlock ? 'blocked' : (existing ? existing.status : 'offline');

  await supabase.from('devices').upsert({
    mac,
    guesses,
    status,
    last_seen: new Date().toISOString(),
  });

  if (willBlock) {
    await supabase.from('logs').insert({
      event: 'Voucher guesses locked',
      actor: 'system',
      detail: mac + ' reached ' + MAX_GUESSES + ' attempts',
    });
  }
}

module.exports = { isBlocked, recordGuess, MAX_GUESSES };
