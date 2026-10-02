// Ends sessions whose time is up: queues a router "remove", marks the
// session ended and the voucher expired. Run every minute from index.js.
const supabase = require('../supabaseClient');
const mikrotik = require('./mikrotik');

async function sweep() {
  const now = new Date().toISOString();
  const { data: due } = await supabase
    .from('sessions')
    .select('id, mac')
    .eq('status', 'active')
    .lt('expires_at', now);

  for (const s of due || []) {
    await supabase.from('sessions').update({ status: 'ended' }).eq('id', s.id);

    // If the device bought again, it has a newer live session — leave
    // its router user alone.
    const { count } = await supabase
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('mac', s.mac)
      .eq('status', 'active')
      .gt('expires_at', now);
    if (count > 0) continue;

    await mikrotik.removeUser(s.mac);
    await supabase.from('vouchers').update({ status: 'expired' }).eq('mac', s.mac).eq('status', 'active');
    await supabase.from('devices').update({ status: 'offline' }).eq('mac', s.mac);
    await supabase.from('logs').insert({ event: 'Session expired', actor: 'system', detail: s.mac });
  }
  return (due || []).length;
}

module.exports = { sweep };
