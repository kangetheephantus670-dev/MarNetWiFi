

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

const TOKEN_TTL = "30m";        
const MAX_FAILS = 3;            
const LOCK_MS = 15 * 60 * 1000; 

const fails = new Map(); 

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

async function audit(event, actor, detail) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, actor, detail }));
}

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
    origin: ADMIN_ORIGIN,           
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
router.use(express.json({ limit: "10kb" }));

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

router.get("/overview", requireAdmin, async (req, res) => {
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
