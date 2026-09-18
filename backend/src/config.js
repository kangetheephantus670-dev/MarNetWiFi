require('dotenv').config();

function list(name) {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
  allowedOrigins: list('ALLOWED_ORIGINS'),

  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,

  mikrotik: {
    host: process.env.MIKROTIK_HOST,
    port: Number(process.env.MIKROTIK_PORT || 8728),
    user: process.env.MIKROTIK_USER,
    password: process.env.MIKROTIK_PASSWORD,
    profile: process.env.MIKROTIK_HOTSPOT_PROFILE || undefined,
  },

  mpesa: {
    env: process.env.MPESA_ENV || 'sandbox',
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE,
    passkey: process.env.MPESA_PASSKEY,
    callbackUrl: process.env.MPESA_CALLBACK_URL,
    // Only needed for the Till "paste your M-Pesa code" flow (C2B), which
    // is separate from the STK push flow above.
    c2bConfirmationUrl: process.env.MPESA_C2B_CONFIRMATION_URL,
    c2bValidationUrl: process.env.MPESA_C2B_VALIDATION_URL,
  },

  // Every plan is provisioned at this speed unless its own row in `plans`
  // says otherwise — kept here as a single source of truth for the "3
  // Mbps for everyone by default" policy.
  defaultSpeedMbps: Number(process.env.DEFAULT_SPEED_MBPS || 3),

  // How often (ms) to pull live data usage from MikroTik's active hotspot
  // users and write it into sessions.data_used_mb, for the admin console's
  // "daily usage" view. 0 disables the background sync.
  usageSyncIntervalMs: Number(process.env.USAGE_SYNC_INTERVAL_MS || 5 * 60 * 1000),
};
