// Everything here (except /login) requires a valid admin token — see
// middleware/auth.js. This is what marnet-admin.html should eventually
// call instead of its current local mock data.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const supabase = require('../supabaseClient');
const config = require('../config');
const { requireAdmin } = require('../middleware/auth');
const mikrotik = require('../services/mikrotik');
const mpesa = require('../services/mpesa');
const { randomCode } = require('../utils/codes');

const router = express.Router();

// 3 attempts per 15 minutes per IP — matches the admin console's own
// stated "lock after 3 failed sign-ins" policy, enforced server-side
// where it actually can't be bypassed.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Enter a username and password' });
    }

    const { data: admin } = await supabase
      .from('admins')
      .select('*')
      .eq('username', username)
      .maybeSingle();

    const ok = admin && await bcrypt.compare(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect username or password' });

    const token = jwt.sign({ sub: username }, config.jwtSecret, { expiresIn: '12h' });
    await supabase.from('logs').insert({ event: 'Operator signed in', actor: username, detail: 'From console' });
    res.json({ token, username });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ username: req.admin.sub });
});

router.patch('/account', requireAdmin, async (req, res, next) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await supabase.from('admins').update({ password_hash: hash }).eq('username', req.admin.sub);
    await supabase.from('logs').insert({ event: 'Password changed', actor: req.admin.sub, detail: '' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/overview', requireAdmin, async (req, res, next) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [online, unusedCodes, failedPayments, blockedDevices, todaysPayments] = await Promise.all([
      supabase.from('sessions').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('vouchers').select('code', { count: 'exact', head: true }).eq('status', 'unused'),
      supabase.from('payments').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
      supabase.from('devices').select('mac', { count: 'exact', head: true }).eq('status', 'blocked'),
      supabase.from('payments').select('amount').eq('status', 'confirmed').gte('created_at', startOfDay.toISOString()),
    ]);

    const todayKsh = (todaysPayments.data || []).reduce((sum, p) => sum + (p.amount || 0), 0);

    res.json({
      stats: {
        todayKsh,
        online: online.count || 0,
        unusedCodes: unusedCodes.count || 0,
        needsAttention: (failedPayments.count || 0) + (blockedDevices.count || 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/vouchers', requireAdmin, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('vouchers')
      .select('*, plans(duration, price)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ vouchers: data });
  } catch (err) {
    next(err);
  }
});

router.post('/vouchers', requireAdmin, async (req, res, next) => {
  try {
    const { planId, count, note } = req.body || {};
    if (!planId) return res.status(400).json({ error: 'Choose a plan first' });

    const n = Math.max(1, Math.min(20, parseInt(count, 10) || 1));
    const codes = [];
    for (let i = 0; i < n; i++) {
      const code = randomCode('MN', 6);
      codes.push(code);
      await supabase.from('vouchers').insert({ code, plan_id: planId, status: 'unused', note });
    }

    await supabase.from('logs').insert({
      event: 'Voucher created',
      actor: req.admin.sub,
      detail: codes.join(', ') + (note ? ' — note: ' + note : ''),
    });

    res.json({ codes });
  } catch (err) {
    next(err);
  }
});

router.patch('/vouchers/:code', requireAdmin, async (req, res, next) => {
  try {
    const { action } = req.body || {}; // 'revoke' | 'unblock'
    const updates =
      action === 'revoke' ? { status: 'expired' } :
      action === 'unblock' ? { status: 'unused', mac: null } :
      null;
    if (!updates) return res.status(400).json({ error: 'Unsupported action' });

    await supabase.from('vouchers').update(updates).eq('code', req.params.code);
    await supabase.from('logs').insert({ event: 'Voucher ' + action + 'd', actor: req.admin.sub, detail: req.params.code });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/sessions', requireAdmin, async (req, res, next) => {
  try {
    // phone/customer_name are selected directly off sessions (denormalized
    // at creation time) so the console can show who a device belongs to
    // without an extra join.
    const { data, error } = await supabase
      .from('sessions')
      .select('*, plans(duration)')
      .order('started_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ sessions: data });
  } catch (err) {
    next(err);
  }
});

// Backs "Admin can see daily usage of a particular client" — every
// session for this MAC that started today, plus the total across them.
// data_used_mb on each row is kept current by the background usage-sync
// job (services/usage.js), which polls MikroTik directly.
router.get('/usage/:mac', requireAdmin, async (req, res, next) => {
  try {
    const mac = req.params.mac.toUpperCase();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data, error } = await supabase
      .from('sessions')
      .select('*, plans(duration)')
      .eq('mac', mac)
      .gte('started_at', startOfDay.toISOString())
      .order('started_at', { ascending: false });
    if (error) throw error;

    const todayMb = (data || []).reduce((sum, s) => sum + (s.data_used_mb || 0), 0);
    res.json({ mac, todayMb, sessions: data });
  } catch (err) {
    next(err);
  }
});

router.post('/sessions/:mac/disconnect', requireAdmin, async (req, res, next) => {
  try {
    const mac = req.params.mac;
    await mikrotik.removeUser(mac).catch(() => {});
    await supabase.from('sessions').update({ status: 'ended' }).eq('mac', mac).eq('status', 'active');
    await supabase.from('logs').insert({ event: 'Device disconnected', actor: req.admin.sub, detail: mac });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/payments', requireAdmin, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ payments: data });
  } catch (err) {
    next(err);
  }
});

// Raw C2B confirmations — the "client paid the Till directly, no STK
// push involved" flow. Separate from /payments (which is STK-only) since
// they're two different payment rails.
router.get('/mpesa-receipts', requireAdmin, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('mpesa_receipts')
      .select('*, plans(duration)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ receipts: data });
  } catch (err) {
    next(err);
  }
});

// 7-day revenue trend for the Overview chart, combining both payment
// rails (STK-confirmed payments + C2B receipts) by calendar day.
router.get('/analytics/revenue7d', requireAdmin, async (req, res, next) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 6);
    since.setHours(0, 0, 0, 0);

    const [{ data: pays, error: e1 }, { data: receipts, error: e2 }] = await Promise.all([
      supabase.from('payments').select('amount, created_at').eq('status', 'confirmed').gte('created_at', since.toISOString()),
      supabase.from('mpesa_receipts').select('amount, created_at').gte('created_at', since.toISOString()),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;

    const dayKeys = [];
    const byDay = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const key = d.toDateString();
      dayKeys.push(key);
      byDay[key] = 0;
    }
    const add = (rows) => {
      (rows || []).forEach((r) => {
        const key = new Date(r.created_at).toDateString();
        if (key in byDay) byDay[key] += r.amount || 0;
      });
    };
    add(pays);
    add(receipts);

    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const revenue7d = dayKeys.map((key) => ({
      d: labels[new Date(key).getDay()],
      v: byDay[key],
    }));

    res.json({ revenue7d });
  } catch (err) {
    next(err);
  }
});

router.get('/devices', requireAdmin, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('devices')
      .select('*')
      .order('last_seen', { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({ devices: data });
  } catch (err) {
    next(err);
  }
});

router.patch('/devices/:mac', requireAdmin, async (req, res, next) => {
  try {
    const mac = req.params.mac;
    const { action, speedMbps } = req.body || {}; // 'block' | 'unblock' | 'setSpeed'

    if (action === 'block') {
      await mikrotik.removeUser(mac).catch(() => {});
      await supabase.from('devices').update({ status: 'blocked' }).eq('mac', mac);
    } else if (action === 'unblock') {
      await supabase.from('devices').update({ status: 'offline', guesses: 0 }).eq('mac', mac);
    } else if (action === 'setSpeed') {
      const mbps = speedMbps ? parseInt(speedMbps, 10) : null;
      await mikrotik.setRateLimit(mac, mbps).catch(() => {});
      await supabase.from('devices').update({ speed_override: mbps }).eq('mac', mac);
    } else {
      return res.status(400).json({ error: 'Unsupported action' });
    }

    await supabase.from('logs').insert({ event: 'Device ' + action, actor: req.admin.sub, detail: mac });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/logs', requireAdmin, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw error;
    res.json({ logs: data });
  } catch (err) {
    next(err);
  }
});

router.get('/plans', requireAdmin, async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('plans').select('*').order('price', { ascending: true });
    if (error) throw error;
    res.json({ plans: data });
  } catch (err) {
    next(err);
  }
});

router.patch('/plans/:id', requireAdmin, async (req, res, next) => {
  try {
    const { price, devicesAllowed, speedMbps, popular } = req.body || {};
    const updates = {};
    if (price !== undefined) updates.price = price;
    if (devicesAllowed !== undefined) updates.devices_allowed = devicesAllowed;
    if (speedMbps !== undefined) updates.speed_mbps = speedMbps;
    if (popular !== undefined) updates.popular = popular;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    await supabase.from('plans').update(updates).eq('id', req.params.id);
    await supabase.from('logs').insert({ event: 'Plan updated', actor: req.admin.sub, detail: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Backs the Settings -> MikroTik "Test connection" button.
router.post('/test-mikrotik', requireAdmin, async (req, res) => {
  try {
    const identity = await mikrotik.testConnection(req.body || {});
    res.json({ ok: true, identity: identity.name || null });
  } catch (err) {
    res.status(502).json({ error: 'Unknown error' });
  }
});

// Backs the Settings -> M-Pesa "Register C2B URL" button — the one-time
// call that tells Safaricom where to send Till payment notifications.
// See README section 3b for the Daraja-side prerequisites.
router.post('/mpesa/register-c2b', requireAdmin, async (req, res) => {
  try {
    const result = await mpesa.registerC2BUrl();
    await supabase.from('logs').insert({
      event: 'M-Pesa C2B URL registered',
      actor: req.admin.sub,
      detail: (result && result.ResponseDescription) || 'Registered',
    });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[marnet]', err);
    res.status(502).json({ error: 'Unknown error' });
  }
});

module.exports = router;
