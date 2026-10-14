
const express = require('express');
const supabase = require('../supabaseClient');
const config = require('../config');

const router = express.Router();
const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const SAFE = /^[A-Za-z0-9]+$/;

router.get('/poll', async (req, res) => {
  if (!config.routerPollKey || req.query.key !== config.routerPollKey) {
    return res.status(401).type('text/plain').send('unauthorized');
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
      if (!MAC.test(j.mac)) continue;
      if (j.action === 'add' && SAFE.test(j.username || '') && SAFE.test(j.password || '')) {
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

module.exports = router;
