// admin-auth.js — server-side admin authentication for MarNet WiFi (Express)
//
// Install:  npm i express helmet cors express-rate-limit jsonwebtoken bcryptjs
//
// Environment variables (set in Render > Environment, never in the repo):
//   ADMIN_USER        e.g. "mark"
//   ADMIN_PASS_HASH   bcrypt hash (generate with: node make-hash.js "your long passphrase")
//   JWT_SECRET        64+ random chars (node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
//   ADMIN_ORIGIN      e.g. "https://kangetheephantus670-dev.github.io"  (origin only, no path)

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const { ADMIN_USER, ADMIN_PASS_HASH, JWT_SECRET, ADMIN_ORIGIN } = process.env;
if (!ADMIN_USER || !ADMIN_PASS_HASH || !JWT_SECRET || !ADMIN_ORIGIN) {
  throw new Error("Missing ADMIN_USER / ADMIN_PASS_HASH / JWT_SECRET / ADMIN_ORIGIN");
}

const TOKEN_TTL = "30m";        // short-lived session
const MAX_FAILS = 3;            // failed sign-ins before lockout
const LOCK_MS = 15 * 60 * 1000; // 15 minutes

// --- lockout state (in memory; move to Supabase/Redis if you run >1 instance) ---
const fails = new Map(); // key: ip -> { count, lockedUntil }

function lockInfo(ip) {
  const rec = fails.get(ip);
  if (!rec) return { locked: false };
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  }
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) fails.delete(ip);
  return { locked: false };
}

function recordFail(ip) {
  const rec = fails.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILS) {
    rec.lockedUntil = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  fails.set(ip, rec);
}

// --- audit log: replace body with an insert into your Supabase `logs` table ---
async function audit(event, actor, detail) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, actor, detail }));
}

// --- middleware: protects every /admin/* route except login ---
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    next();
  } catch {
    return res.status(401).json({ error: "Session expired" });
  }
}

const router = express.Router();

router.use(helmet());
router.use(
  cors({
    origin: ADMIN_ORIGIN,            // only your admin page may call this
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
router.use(express.json({ limit: "10kb" }));

// Extra network-level throttle on top of the lockout
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/login", loginLimiter, async (req, res) => {
  const ip = req.ip; // requires app.set("trust proxy", 1) on Render
  const lock = lockInfo(ip);
  if (lock.locked) {
    return res.status(429).json({ error: "Locked", retryAfterSec: lock.retryAfterSec });
  }

  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Invalid request" });
  }

  // Always run bcrypt so response time doesn't reveal whether the username was right
  const passOk = await bcrypt.compare(password, ADMIN_PASS_HASH);
  const userOk = username === ADMIN_USER;

  if (!(userOk && passOk)) {
    recordFail(ip);
    await audit("admin_login_failed", username.slice(0, 40), { ip });
    return res.status(401).json({ error: "Wrong username or password" });
  }

  fails.delete(ip);
  const token = jwt.sign({ sub: ADMIN_USER, role: "operator" }, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: TOKEN_TTL,
  });
  await audit("admin_login", ADMIN_USER, { ip });
  res.json({ token, expiresIn: TOKEN_TTL });
});

router.post("/logout", requireAdmin, async (req, res) => {
  await audit("admin_logout", req.admin.sub, { ip: req.ip });
  res.json({ ok: true }); // client discards the token
});

// ---- Example protected routes: every admin action goes behind requireAdmin ----
router.get("/overview", requireAdmin, async (req, res) => {
  // TODO: query Supabase with the SERVICE key (server-side only)
  res.json({ revenue7d: [], online: [] });
});

router.post("/vouchers", requireAdmin, async (req, res) => {
  // TODO: validate plan + count (e.g. count between 1 and 100), generate long random codes
  await audit("voucher_create", req.admin.sub, { plan: req.body.plan, count: req.body.count });
  res.json({ codes: [] });
});

router.post("/grant-time", requireAdmin, async (req, res) => {
  // TODO: validate MAC format, duration, speed, then call MikroTik from the server
  await audit("grant_time", req.admin.sub, req.body);
  res.json({ ok: true });
});

router.post("/devices/:mac/block", requireAdmin, async (req, res) => {
  await audit("device_block", req.admin.sub, { mac: req.params.mac });
  res.json({ ok: true });
});

module.exports = { router, requireAdmin };

// ---- Wire it up in your main server file ----
//   const app = express();
//   app.set("trust proxy", 1);
//   const { router: adminRouter } = require("./admin-auth");
//   app.use("/admin", adminRouter);
