-- MarNet WiFi — Supabase schema
-- Run this once in the Supabase SQL editor on a fresh project
-- (Project -> SQL Editor -> New query -> paste this -> Run).

create extension if not exists "pgcrypto";

-- The packages shown on the captive portal. speed_mbps is enforced on the
-- router and is never sent to or shown on the client-facing page.
-- Default is 3 Mbps across every package and every customer, per operator
-- policy — edit the seed values below if that policy ever changes.
create table if not exists plans (
  id text primary key,
  duration text not null,
  price integer not null,
  popular boolean not null default false,
  devices_allowed integer not null default 1,
  speed_mbps integer not null default 3
);

-- Pre-printed / manually issued codes. status: unused | active | expired | blocked
create table if not exists vouchers (
  code text primary key,
  plan_id text references plans(id),
  status text not null default 'unused',
  mac text,
  note text,
  created_at timestamptz not null default now()
);

-- One row per STK push attempt. status: pending | confirmed | failed
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  checkout_request_id text unique,
  phone text,
  customer_name text,
  plan_id text references plans(id),
  plan_label text,
  amount integer,
  mac text,
  status text not null default 'pending',
  mpesa_receipt text,
  hotspot_username text,
  hotspot_password text,
  created_at timestamptz not null default now()
);

-- One row per M-Pesa payment Safaricom pushes to the Till's C2B
-- Confirmation URL (see README section 3b). This is the "paste your
-- M-Pesa code" flow: the client pays the Till directly (no STK push),
-- Safaricom notifies us the instant it lands, and the client redeems it
-- on the portal by pasting the same transaction code from their SMS.
-- status lives in `used`: false until redeemed, true once bound to a MAC.
create table if not exists mpesa_receipts (
  code text primary key,
  phone text,
  customer_name text,
  amount integer,
  used boolean not null default false,
  mac text,
  plan_id text references plans(id),
  created_at timestamptz not null default now()
);

-- One row per device ever seen, keyed by MAC address.
-- status: online | offline | blocked
create table if not exists devices (
  mac text primary key,
  status text not null default 'offline',
  guesses integer not null default 0,
  speed_override integer,
  last_seen timestamptz not null default now()
);

-- One row per granted connection window (from a payment, a voucher, or a
-- pasted M-Pesa code). status: active | ended
-- phone/customer_name are denormalized here (copied in at creation time)
-- purely so the admin console's Sessions tab can show who a device
-- belongs to without an extra join per row.
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  mac text not null,
  plan_id text references plans(id),
  phone text,
  customer_name text,
  started_at timestamptz not null default now(),
  expires_at timestamptz,
  data_used_mb integer not null default 0,
  status text not null default 'active',
  hotspot_password text,
  speed_mbps integer
);

-- Audit trail shown on the admin console's Logs tab.
create table if not exists logs (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  actor text not null,
  detail text,
  created_at timestamptz not null default now()
);

-- Operator accounts for the admin console. One row per person who signs in.
create table if not exists admins (
  username text primary key,
  password_hash text not null
);

create index if not exists idx_sessions_mac on sessions(mac);
create index if not exists idx_sessions_status on sessions(status);
create index if not exists idx_payments_checkout on payments(checkout_request_id);
create index if not exists idx_vouchers_mac on vouchers(mac);
create index if not exists idx_devices_status on devices(status);
create index if not exists idx_mpesa_receipts_used on mpesa_receipts(used);
create index if not exists idx_sessions_started on sessions(started_at);

-- Seed the plans to match marnet-portal.html / marnet-admin.html as they
-- stand today. Every plan is capped at the same 3 Mbps by policy — edit
-- prices/durations here later, or from the admin console's Plans tab.
insert into plans (id, duration, price, popular, devices_allowed, speed_mbps) values
  ('p30m',   '30 min',  5,   false, 1, 3),
  ('p1h',    '1 hr',    8,   false, 1, 3),
  ('p3h',    '3 hrs',   10,  false, 1, 3),
  ('p12h',   '12 hrs',  20,  true,  1, 3),
  ('p24h',   '24 hrs',  25,  true,  1, 3),
  ('p3d',    '3 days',  55,  false, 1, 3),
  ('p1w',    '1 week',  135, false, 1, 3),
  ('p2w',    '2 weeks', 270, false, 1, 3),
  ('p1mo',   '1 month', 579, false, 1, 3),
  ('p1mo2d', '1 month', 900, false, 2, 3)
on conflict (id) do nothing;

-- Seed one operator account so you can sign in to the admin console.
-- Username: operator   Password: MarNet742
-- CHANGE THIS PASSWORD as soon as you sign in for the first time —
-- pgcrypto's bf hash here is bcrypt-compatible, which is what the backend
-- checks logins against.
insert into admins (username, password_hash) values
  ('operator', crypt('MarNet742', gen_salt('bf')))
on conflict (username) do nothing;
