# MarNet WiFi — backend

One backend for both `marnet-portal.html` (the client captive portal) and
`marnet-admin.html` (the operator console). Public routes under `/api/*`
serve the portal; everything under `/api/admin/*` requires a signed-in
operator.

## What it does

- Takes M-Pesa payments via Safaricom Daraja (STK push), and on
  confirmation creates a MikroTik hotspot user pinned to the paying
  device's MAC address — so the router can auto-authenticate that one
  device with no login form, and no other device can piggyback on it.
- Sells/redeems pre-printed vouchers the same way.
- Lets an operator manage vouchers, sessions, payments, devices (block,
  unblock, throttle) and plans (price, popularity, speed cap) from
  `marnet-admin.html`.
- Every unexpected failure returns `{ "error": "Unknown error" }` to the
  caller and logs the real detail server-side only — nothing about how
  the system works leaks through an error message.

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Project → SQL Editor → New query → paste in `sql/schema.sql` → Run.
   This creates every table, seeds the current plans, and creates one
   operator login: **username `operator`, password `MarNet742`.**
3. Project → Settings → API → copy the **Project URL** and the
   **`service_role` key** (not the `anon` key — the backend needs to
   bypass row-level security to manage everything).

## 2. Set up MikroTik

1. Winbox/Terminal → `IP → Services` → make sure `api` is enabled
   (default port `8728`).
2. Create a dedicated API user (`System → Users`) rather than reusing
   `admin` — give it the `api` and `hotspot` policy groups only.
3. On your hotspot's server profile (`IP → Hotspot → Server Profiles`),
   set the **Login** method to include **`mac`**. This is what lets a
   device connect automatically once its MAC is added as a hotspot user
   — no login page round-trip needed.
4. If your router isn't reachable from the public internet (usual for a
   home/shop router), the backend needs to run somewhere that *can* reach
   it — e.g. on a small VPN back to the site, or on a machine on the same
   LAN as the router. Render (a common free host) can't reach a private
   router IP directly; that's the one piece of this setup that depends on
   your specific network, not on this code.

## 3. Set up Safaricom Daraja

1. Register an app at
   [developer.safaricom.co.ke](https://developer.safaricom.co.ke) and
   grab the sandbox **Consumer Key/Secret** to start.
2. Sandbox shortcode `174379` and its passkey are published on the Daraja
   docs — use those for `MPESA_SHORTCODE` / `MPESA_PASSKEY` while testing.
3. `MPESA_CALLBACK_URL` must be a public HTTPS URL Safaricom can reach —
   your deployed backend's `/api/mpesa/callback`. This can't be
   `localhost`; Daraja needs to reach it from the internet.
4. Move to a real paybill/till and production keys once you're ready to
   take live payments.

### 3b. The "paste your M-Pesa code" flow (Till only)

This is a second, separate way to get online: a client pays your Till
directly — no app, no STK push — then pastes the transaction code from
their confirmation SMS (e.g. `UIGL56IRMO`) into the same voucher box on
the portal. It needs one extra piece of setup, once your Till exists:

1. Fill in `MPESA_C2B_CONFIRMATION_URL` and `MPESA_C2B_VALIDATION_URL` in
   `.env` — both must be public HTTPS URLs on this deployed backend
   (`/api/mpesa/c2b/confirmation` and `/api/mpesa/c2b/validation`).
2. Deploy the backend with those values set.
3. Sign in to the admin console → Settings → **Register M-Pesa C2B URL**.
   This makes one API call (`registerurl`) telling Safaricom where to
   send every future payment to this Till. You only need to do this
   once per shortcode — again only if you ever change the URLs.
4. Note: registering against the **sandbox** shortcode is fine for
   testing the plumbing, but won't reflect real Till payments. Your real
   Till also typically needs Safaricom's go-live approval before C2B
   registration against it takes effect — that approval step is outside
   this codebase.

Every payment that lands on the Till this way is stored in
`mpesa_receipts` the instant Safaricom confirms it — before anyone even
opens the portal. The portal's `/api/voucher/redeem` endpoint checks a
pasted code against that table (if it's not an admin-minted `MN######`
voucher), matching the payment's amount to a plan and provisioning the
device exactly like a voucher does.

## 4. Configure and run

```bash
cp .env.example .env
# fill in the Supabase / MikroTik / Daraja values above
npm install
npm start
```

`GET /api/health` should return `{"ok":true,...}`.

## 5. Deploy

Any Node host works (Render, Railway, Fly.io, a VPS). On Render
specifically: New → Web Service → point at this repo, build command
`npm install`, start command `npm start`, and add every variable from
`.env.example` under Environment. Free instances sleep after inactivity —
that's why the portal pings `/api/health` as soon as it loads, to wake
the backend before the person picks a plan.

## API reference

### Public — called by `marnet-portal.html`

| Route | Body | Returns |
|---|---|---|
| `GET /api/health` | — | `{ ok }` |
| `POST /api/stk-push` | `{ phone, plan, amount, device }` | `{ checkoutRequestId }` |
| `GET /api/status/:id` | — | `{ status: "queued"\|"provisioned"\|"failed", hotspotUsername?, hotspotPassword? }` |
| `POST /api/reconnect` | `{ device }` | `{ ok }` |
| `POST /api/voucher/redeem` | `{ code, device }` | `{ ok, message, expired?, remainingMinutes? }` — accepts either an admin-minted `MN######` voucher or a pasted M-Pesa transaction code |
| `POST /api/mpesa/callback` | *(Safaricom only — STK push result)* | — |
| `POST /api/mpesa/c2b/validation` | *(Safaricom only — Till payment, pre-check)* | — |
| `POST /api/mpesa/c2b/confirmation` | *(Safaricom only — Till payment, confirmed)* | — |

`device` is `{ mac }` — the MAC address MikroTik hands the portal in the
redirect query string.

### Admin — needs `Authorization: Bearer <token>` from `/api/admin/login`

| Route | Notes |
|---|---|
| `POST /api/admin/login` | `{ username, password }` → `{ token }`. 3 attempts / 15 min per IP. |
| `GET /api/admin/me` | Who's signed in |
| `PATCH /api/admin/account` | `{ newPassword }` |
| `GET /api/admin/overview` | Dashboard stats |
| `GET/POST /api/admin/vouchers` | List / mint (`{ planId, count, note }`) |
| `PATCH /api/admin/vouchers/:code` | `{ action: "revoke"\|"unblock" }` |
| `GET /api/admin/sessions` | |
| `POST /api/admin/sessions/:mac/disconnect` | |
| `GET /api/admin/payments` | |
| `GET /api/admin/devices` | |
| `PATCH /api/admin/devices/:mac` | `{ action: "block"\|"unblock"\|"setSpeed", speedMbps? }` |
| `GET /api/admin/logs` | |
| `GET /api/admin/plans` | |
| `PATCH /api/admin/plans/:id` | `{ price?, devicesAllowed?, speedMbps?, popular? }` |
| `GET /api/admin/mpesa-receipts` | Raw Till (C2B) payments — separate from `/payments`, which is STK-only |
| `GET /api/admin/usage/:mac` | Today's sessions + total data used for one device |
| `GET /api/admin/analytics/revenue7d` | 7-day revenue trend, combining both payment rails |
| `POST /api/admin/test-mikrotik` | Backs the Settings "Test connection" button |
| `POST /api/admin/mpesa/register-c2b` | One-time C2B URL registration — see section 3b |

## Current state

Both `marnet-portal.html` and `marnet-admin.html` are now wired to this
backend's real routes — no mock data, no client-side demo login. The
admin console signs in against `POST /api/admin/login`, stores the JWT
for the session, and sends it as a Bearer token on every subsequent
call.

**Still worth doing before go-live:**
- The background usage-sync job (`services/usage.js`) only runs if
  `MIKROTIK_HOST` is set — confirm it's polling once the router is
  reachable from wherever the backend is deployed.
- `payments.customer_name` is only ever populated via the C2B flow
  (Safaricom's STK callback doesn't include a name) — expect it to stay
  blank for STK-paid sessions.
- Decide whether admin-minted vouchers should keep existing long-term
  alongside the pasted-M-Pesa-code flow, or eventually be retired.
