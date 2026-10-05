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

const app = express();

app.use(helmet());
app.use(express.json());
app.use(cors({
  origin: config.allowedOrigins.length ? config.allowedOrigins : true,
}));

app.get('/', (req, res) => res.send('MarNet backend is running'));

// Router polls this every ~20s. One job per line, or "OK" when empty.
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

app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/mpesa', mpesaWebhook);

setInterval(() => expiry.sweep().catch(console.error), 60000);

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
