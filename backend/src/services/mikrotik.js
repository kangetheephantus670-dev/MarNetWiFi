// Talks to the MikroTik router's own API (port 8728 by default — this is
// NOT the web/Winbox port). Every hotspot user we create is pinned to one
// MAC address (mac-address=...), so as long as the hotspot server
// profile's login method includes "mac", the router auto-authenticates
// that device with no login form involved. That's what makes "one
// voucher, one device" hold at the network level, not just in the app.
const { RouterOSAPI } = require('node-routeros');
const config = require('../config');

function buildClient(overrides = {}) {
  return new RouterOSAPI({
    host: overrides.host || config.mikrotik.host,
    user: overrides.user || config.mikrotik.user,
    password: overrides.password || config.mikrotik.password,
    port: Number(overrides.port || config.mikrotik.port || 8728),
    timeout: 8,
  });
}

async function withConnection(fn, overrides) {
  const conn = buildClient(overrides);
  await conn.connect();
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

// Used by the admin console's Settings -> "Test connection" button.
async function testConnection(overrides) {
  return withConnection(async (conn) => {
    const identity = await conn.write('/system/identity/print');
    return identity[0] || {};
  }, overrides);
}

// Creates (or replaces) a hotspot user pinned to one MAC address.
// - limitUptime: RouterOS duration string, e.g. "1h", "3d", "30m".
//   Leave undefined for an already-time-credited renewal.
// - rateLimitMbps: a plain number; converted to RouterOS's "rx/tx" format.
async function provisionUser({ mac, username, password, limitUptime, rateLimitMbps }) {
  // Falls back to the flat policy default (3 Mbps) if a caller doesn't
  // pass a speed — e.g. a plan row with no speed_mbps set.
  const speed = rateLimitMbps || config.defaultSpeedMbps;

  return withConnection(async (conn) => {
    // Remove any existing entry for this MAC first, so renewals or plan
    // changes don't collide with a stale row from an earlier session.
    const existing = await conn.write('/ip/hotspot/user/print', ['?mac-address=' + mac]);
    for (const u of existing) {
      await conn.write('/ip/hotspot/user/remove', ['=.id=' + u['.id']]);
    }

    const params = [
      '=name=' + username,
      '=password=' + password,
      '=mac-address=' + mac,
    ];
    if (config.mikrotik.profile) params.push('=profile=' + config.mikrotik.profile);
    if (limitUptime) params.push('=limit-uptime=' + limitUptime);
    if (speed) params.push('=rate-limit=' + speed + 'M/' + speed + 'M');

    await conn.write('/ip/hotspot/user/add', params);
    return true;
  });
}

// Used by the admin console's per-device "Set speed" / "Remove limit"
// action, for throttling a device the operator suspects is misusing its
// connection. The device is never told — it just loads slower.
async function setRateLimit(mac, mbps) {
  return withConnection(async (conn) => {
    const rows = await conn.write('/ip/hotspot/user/print', ['?mac-address=' + mac]);
    if (!rows.length) return false;

    await conn.write('/ip/hotspot/user/set', [
      '=.id=' + rows[0]['.id'],
      '=rate-limit=' + (mbps ? mbps + 'M/' + mbps + 'M' : ''),
    ]);

    // Force a re-login so the new limit takes effect immediately, instead
    // of only applying the next time the device reconnects on its own.
    const active = await conn.write('/ip/hotspot/active/print', ['?mac-address=' + mac]);
    for (const a of active) {
      await conn.write('/ip/hotspot/active/remove', ['=.id=' + a['.id']]);
    }
    return true;
  });
}

// Used when blocking a device, disconnecting a session from the admin
// console, or ending an expired voucher's access.
async function removeUser(mac) {
  return withConnection(async (conn) => {
    const rows = await conn.write('/ip/hotspot/user/print', ['?mac-address=' + mac]);
    for (const r of rows) {
      await conn.write('/ip/hotspot/user/remove', ['=.id=' + r['.id']]);
    }
    const active = await conn.write('/ip/hotspot/active/print', ['?mac-address=' + mac]);
    for (const a of active) {
      await conn.write('/ip/hotspot/active/remove', ['=.id=' + a['.id']]);
    }
    return true;
  });
}

// Used by "Already paid?" on the client portal, to double-check the
// router still has the device authorised (in case it rebooted).
async function isOnline(mac) {
  return withConnection(async (conn) => {
    const active = await conn.write('/ip/hotspot/active/print', ['?mac-address=' + mac]);
    return active.length > 0;
  });
}

// Reads every currently-active hotspot session straight from the router
// (not our database) and returns each device's live cumulative data
// usage. Used by the background usage-sync job that populates
// sessions.data_used_mb, which is what backs the admin console's
// "how much has this client used" view. RouterOS resets these counters
// per login, so the number is exactly "usage for this session so far" —
// which for a time-boxed plan or voucher period is the daily/period
// figure the operator cares about.
async function listActiveUsage() {
  return withConnection(async (conn) => {
    const rows = await conn.write('/ip/hotspot/active/print');
    return rows
      .map((r) => ({
        mac: String(r['mac-address'] || '').toUpperCase(),
        bytesIn: Number(r['bytes-in'] || 0),
        bytesOut: Number(r['bytes-out'] || 0),
      }))
      .filter((r) => r.mac);
  });
}

module.exports = { testConnection, provisionUser, setRateLimit, removeUser, isOnline, listActiveUsage };
