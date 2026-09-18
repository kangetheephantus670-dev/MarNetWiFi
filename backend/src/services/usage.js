// Periodically pulls live byte counters for every active hotspot session
// from MikroTik and writes them into sessions.data_used_mb. This is the
// only thing that actually populates that column — without it, "daily
// usage" in the admin console would just be a permanent zero.
const supabase = require('../supabaseClient');
const mikrotik = require('./mikrotik');

async function syncUsage() {
  const active = await mikrotik.listActiveUsage();

  for (const row of active) {
    const mb = Math.round((row.bytesIn + row.bytesOut) / (1024 * 1024));
    await supabase
      .from('sessions')
      .update({ data_used_mb: mb })
      .eq('mac', row.mac)
      .eq('status', 'active');
  }

  return active.length;
}

module.exports = { syncUsage };
