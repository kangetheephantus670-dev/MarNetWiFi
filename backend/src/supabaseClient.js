const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

if (!config.supabaseUrl || !config.supabaseServiceKey) {
  // Don't crash on boot over this — it just means every DB call below
  // will fail with a clear error until .env is filled in, which is more
  // useful than the server refusing to start at all.
  console.warn(
    '[marnet] SUPABASE_URL / SUPABASE_SERVICE_KEY are not set yet — ' +
    'database calls will fail until they are.'
  );
}

const supabase = createClient(
  config.supabaseUrl || 'https://placeholder.supabase.co',
  config.supabaseServiceKey || 'placeholder-key',
  { auth: { persistSession: false } }
);

module.exports = supabase;
