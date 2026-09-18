const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const mpesaWebhook = require('./routes/mpesaWebhook');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const usage = require('./services/usage');

const app = express();

app.use(helmet());
app.use(express.json());
app.use(cors({
  // Falls back to allowing any origin only if ALLOWED_ORIGINS was left
  // empty — fine for local testing, but set it for real before deploying.
  origin: config.allowedOrigins.length ? config.allowedOrigins : true,
}));

app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/mpesa', mpesaWebhook);

app.use(notFound);
app.use(errorHandler);

app.listen(config.port, () => {
  console.log('MarNet backend listening on port ' + config.port);
});

// Keeps sessions.data_used_mb current so the admin console's per-client
// usage view isn't permanently zero. Only runs if a MikroTik host is
// configured, and never lets one failed poll crash the server.
if (config.mikrotik.host && config.usageSyncIntervalMs > 0) {
  setInterval(() => {
    usage.syncUsage().catch((err) => console.error('[marnet] usage sync failed', err));
  }, config.usageSyncIntervalMs);
}
