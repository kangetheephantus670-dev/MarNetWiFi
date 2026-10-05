// PULL MODE: Render can't reach the router, so jobs are queued in the
// router_jobs table and the router fetches them from /api/router/poll.
const supabase = require('../supabaseClient');
const config = require('../config');

async function queue(row) {
  // The latest instruction for a device wins: retire older pending jobs.
  await supabase
    .from('router_jobs')
    .update({ status: 'superseded' })
    .eq('mac', row.mac)
    .eq('status', 'pending');
  const { error } = await supabase.from('router_jobs').insert(row);
  if (error) throw error;
  return true;
}

async function provisionUser({ mac, username, password, rateLimitMbps }) {
  return queue({
    action: 'add',
    mac,
    username,
    password,
    rate_mbps: rateLimitMbps || config.defaultSpeedMbps,
  });
}

async function removeUser(mac) {
  return queue({ action: 'remove', mac });
}

async function setRateLimit(mac, mbps) {
  const { data: session } = await supabase
    .from('sessions')
    .select('hotspot_password')
    .eq('mac', mac)
    .eq('status', 'active')
    .order('expires_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!session) return false;
  return queue({
    action: 'add',
    mac,
    username: mac.replace(/:/g, ''),
    password: session.hotspot_password,
    rate_mbps: mbps || config.defaultSpeedMbps,
  });
}

async function isOnline() { return true; }
async function listActiveUsage() { return []; }
async function testConnection() { return { name: 'pull-mode (router polls Render)' }; }

module.exports = { testConnection, provisionUser, setRateLimit, removeUser, isOnline, listActiveUsage };
