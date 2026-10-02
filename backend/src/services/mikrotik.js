// PULL MODE: Render can't reach the router, so instead of talking to
// RouterOS directly this file queues jobs in the router_jobs table. The
// router fetches them from GET /api/router/poll (see routes/router.js).
// Function names/signatures match the old file, so vouchers.js,
// mpesaReceipts.js, mpesaWebhook.js and admin.js need no changes.
const supabase = require('../supabaseClient');
const config = require('../config');

async function queue(row) {
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

// Re-queues the user with a new speed (the router script replaces the old
// entry and drops the live session, so the device logs in again).
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

// The router keeps hotspot users across reboots, so there's nothing to heal.
async function isOnline() { return true; }

// Live usage isn't reported in pull mode yet (data_used_mb stays 0).
async function listActiveUsage() { return []; }

async function testConnection() { return { name: 'pull-mode (router polls Render)' }; }

module.exports = { testConnection, provisionUser, setRateLimit, removeUser, isOnline, listActiveUsage };
