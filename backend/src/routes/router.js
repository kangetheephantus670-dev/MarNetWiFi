// The router calls this every ~20s. Returns plain text, one job per line:
//   add,AA:BB:CC:DD:EE:FF,AABBCCDDEEFF,Pass1234,3
//   remove,AA:BB:CC:DD:EE:FF
// or just "OK" when there is nothing to do. Capped at 20 jobs per call
// because RouterOS v6 can only read ~4 KB from a file.
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
