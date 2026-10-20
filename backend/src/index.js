const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const supabase = require('./supabaseClient');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const mpesaWebhook = require('./routes/mpesaWebhook');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const usage = require('./services/usage');
const expiry = require('./services/expiry');
const payments = require('./services/payments');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(express.json());
app.use(cors({
  origin: config.allowedOrigins.length ? config.allowedOrigins : true,
}));

app.get('/', (req, res) => res.send('MarNet backend is running'));

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const SAFE_RE = /^[A-Za-z0-9]+$/;

app.get('/api/router/poll', async (req, res) => {
  if (!config.routerPollKey || req.query.key !== config.routerPollKey) {
    return res.status(401).type('text/plain').send('unauthorized\n');
  }
  try {
    const { data: jobs, error } = await supabase
      .from('router_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(20);
    if (error) throw error;

    const lines = [];
    for (const j of jobs || []) {
      if (!MAC_RE.test(j.mac)) continue;
      if (j.action === 'add' && SAFE_RE.test(j.username || '') && SAFE_RE.test(j.password || '')) {
        lines.push(['add', j.mac, j.username, j.password, parseInt(j.rate_mbps, 10) || 3].join(','));
      } else if (j.action === 'remove') {
        lines.push('remove,' + j.mac);
      }
    }
    const ids = (jobs || []).map((j) => j.id);
    if (ids.length) await supabase.from('router_jobs').update({ status: 'sent' }).in('id', ids);

    res.type('text/plain').send((lines.length ? lines.join('\n') : 'OK') + '\n');
  } catch (err) {
    console.error('[marnet] router poll error', err);
    res.status(500).type('text/plain').send('error\n');
  }
});

app.post('/api/router/usage', express.text({ type: '*/*', limit: '100kb' }), async (req, res) => {
  if (!config.routerPollKey || req.query.key !== config.routerPollKey) {
    return res.status(401).type('text/plain').send('unauthorized\n');
  }
  try {
    const totals = {};
    String(req.body || '').split('\n').forEach((line) => {
      const parts = line.trim().split(',');
      
      // FIXED HERE: Added [0] and [1] to extract array items properly
      const mac = (parts[0] || '').toUpperCase();
      const n = parseInt(parts[1], 10);
      
      if (!MAC_RE.test(mac) || Number.isNaN(n) || n < 0) return;
      totals[mac] = (totals[mac] || 0) + n;
    });

    const now = new Date().toISOString();

    for (const mac of Object.keys(totals)) {
      const reportedBytes = totals[mac];

      const { data: rows, error: sessErr } = await supabase
        .from('sessions')
        .select('id, data_used_mb, last_bytes')
        .eq('mac', mac)
        .eq('status', 'active')
        .order('expires_at', { ascending: false })
        .limit(1);

      if (sessErr) {
        console.error('[usage] session query', mac, sessErr);
      }

      const session = rows && rows[0];

      if (session) {
        const prevBytes = Number(session.last_bytes) || 0;
        let deltaBytes = reportedBytes - prevBytes;
        
        // Handle router byte counter resets safely
        if (deltaBytes < 0) deltaBytes = reportedBytes;

        // Convert byte difference directly to MB to avoid precision loss
        const deltaMb = deltaBytes / 1048576;
        const prevMb = Number(session.data_used_mb) || 0;
        const newUsedMb = Math.round((prevMb + deltaMb) * 100) / 100;

        const { error: updErr } = await supabase
          .from('sessions')
          .update({
            data_used_mb: newUsedMb,
            last_bytes: reportedBytes,
          })
          .eq('id', session.id);

        if (updErr) console.error('[usage] session update', mac, updErr);
        else console.log('[usage] updated', mac, reportedBytes, newUsedMb);
      } else {
        console.log('[usage] no active session for', mac);
      }

      await supabase.from('devices').upsert({
        mac,
        status: 'online',
        last_seen: now,
      });
    }
    res.type('text/plain').send('OK\n');
  } catch (err) {
    console.error('[marnet] usage report error', err);
    res.status(500).type('text/plain').send('error\n');
  }
});

app.use(['/api/mpesa', '/api/pay'], (req, res, next) => {
  console.log('[marnet] safaricom hit', req.method, req.originalUrl, JSON.stringify(req.body || {}).slice(0, 400));
  next();
});

app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/mpesa', mpesaWebhook);
app.use('/api/pay', mpesaWebhook);

setInterval(() => expiry.sweep().catch(console.error), 60000);
setInterval(() => payments.sweepPending().catch(console.error), 20000);

app.use(notFound);
app.use(errorHandler);

app.listen(config.port, () => {
  console.log('MarNet backend listening on port ' + config.port);
});

if (config.mikrotik.host && config.usageSyncIntervalMs > 0) {
  setInterval(() => {
    usage.syncUsage().catch((err) => console.error('[marnet] usage sync failed', err));
  }, config.usageSyncIntervalMs);
}
