# GymsPilotPro multi-tenancy

One backend, one website deployment, one front-desk app — and **one database
per gym**. A gym is served on its own domain(s); the platform owner manages
every gym from a super-admin panel.

```
 gymA.com ─┐                                 ┌─ MongoDB  GymPilot_gyma
 gymB.com ─┤   Next.js site (one deploy)     ├─ MongoDB  GymPilot_gymb
 gymC.com ─┘          │                      │
                      ▼  Origin / X-Tenant-Host
              GymPilot_backend ───────────────┤
              /api/platform  (super admin)    └─ MongoDB  GymPilot  (the main database)
                                                  the original gym's data
                                                  + gyms · platform_plans · super_admins · platform_audit_logs
```

**Database names** (`src/platform/dbNames.js`): the database in `MONGO_URI`
is the main one. It holds the platform's own collections and the first gym.
Every gym created from the panel gets `<main>_<slug>` — `GymPilot_gym1`,
`GymPilot_gym2`, … — unless a different name is typed in the form. The main
database can never be dropped through the panel.

## How a request finds its gym

`src/platform/middleware/resolveTenant.js` runs before every route (except
the exempt ones below). It reads, in order:

1. `X-Tenant-Host` header — sent by the Next.js server for server-side renders
2. `?tenantHost=` query — top-level navigations and cache-keyed fetches
3. `Origin` header — every browser request from a gym's site (set by the browser)
4. `Host` header — a gym pointing its domain straight at the API

Each is matched against the registered domains, then against
`<slug>.PLATFORM_ROOT_DOMAIN`. Then an explicit slug (`X-Tenant-Slug` /
`?tenant=`), then `DEFAULT_TENANT_SLUG`.

* An **explicit** hint (1, 2, or a slug) that matches nothing → `404 TENANT_NOT_FOUND`.
  It never falls back to the default gym, so a new domain that has not been
  registered yet shows "not connected" rather than another gym's site.
* An **ambient** value (3, 4) that matches nothing → `DEFAULT_TENANT_SLUG`, if
  set. This is what keeps a single-gym server and plain `localhost` working.
  **Leave `DEFAULT_TENANT_SLUG` unset on a multi-gym deployment.**

The matched gym is put in an `AsyncLocalStorage` context
(`src/platform/tenantContext.js`). Every model in `src/**/models` is exported
through `tenantModel()` (`src/platform/modelRegistry.js`): the same `User`,
`Package`, `Attendance`… the controllers always used, now bound to the current
gym's connection at the moment they are called. **Using a model outside a
tenant context throws** — nothing can silently read the wrong database.

Connections: gyms on the platform cluster share the primary pool via
`mongoose.connection.useDb(name, { useCache: true })`; a gym with its own
`database.uri` gets a dedicated cached connection (`src/platform/connections.js`).

**Dedicated-cluster contract.** `database.uri` is `select: false` on the Gym
schema, so a plain `Gym.findOne()` does not return it — and a gym looked up
that way is silently served from the *shared* cluster. Every lookup that
leads to a connection must therefore go through one of the statics that
re-select it: **`Gym.findBySlug(slug)`, `Gym.findByHost(host)` and
`Gym.findByIdWithUri(id)` return the uri** (lean documents). `resolveTenant`,
`tenantFromPayload`, `jobs.js`, `tenantStats.js` and the panel's controllers
all do; the mobile sign-in must use `findByIdWithUri` / `findBySlug` too.
Nothing may serialise such a document to a client: the panel goes through
`publicGym()`, which replaces `database` with `{ name }`.

### Exempt paths

| Path | Why |
|---|---|
| `/`, `/health`, `/robots.txt`, `/uploads/*` | need no gym |
| `/api/platform/*` | the super-admin panel; manages gyms, belongs to none |
| `/api/jobs/*` | the cron; loops over every gym itself |
| `/auth/google/callback` | Google calls the API directly — gym is read from OAuth `state` |
| `/api/gymfolio/payment/webhook` | Stripe calls the API directly — gym is read from the event's `metadata.tenantSlug` |

### What is bound to the gym

* **JWTs** carry `tid` (the gym id). `middleware/auth` refuses a token on any
  other gym's request; platform tokens are refused on every gym route.
* **Links in emails and redirects** (`frontendOrigin()` / `siteUrlFor(gym)`)
  come from the gym's *registered* primary domain, never from a raw header.
  A gym with no registered domain gets `https://<slug>.<PLATFORM_ROOT_DOMAIN>`
  when a root domain is set; only without one does the env `FRONTEND_ORIGIN`
  fallback apply (so local development with no root domain behaves as before).
  The panel returns the same answer as `siteUrl` on every gym.
* **Entitlements** (`src/platform/entitlements.js`): `gymHasAddon(gym, slug)`
  is true when the gym has no plan (an unconfigured or free-hosted platform),
  when its plan's `includedAddons` lists the slug, or when `subscription.addons`
  carries it. The member app is the add-on `member-app`; the mobile sign-in
  asks `gymHasAddon(gym, 'member-app')`. `planFor(gym)` returns the (cached)
  plan document behind `gym.plan`.
* **Timezone** comes from `gym.locale.timezone` (`timeUtils.timezone()`), so
  attendance, timetables and reminders run on each gym's clock.
* **Uploads** land in `uploads/<slug>/…` (disk) or `<slug>/<folder>/…` (Vercel Blob).
* **Caches** that used to be per-process — roles, email branding, ledger
  currency, membership-expiry sweep, desktop login throttle — are keyed per gym.
* **Plan limits** (`src/platform/planLimits.js`): members, staff, trainers,
  classes — checked on creation; 0 = unlimited.

## The platform panel

App: `GymPilot_marketing` -- the marketing site at `/` and the panel at `/super-admin` (sign in at `/login`); the gym website redirects its old `/super-admin` links there. API: `/api/platform/*` (public, no session: `/api/platform/public/plans`, `/api/platform/public/addons`, `/api/platform/public/config` → `{ root_domain, self_serve_signup }`, `POST /api/platform/public/demo-requests`, and the self-serve sign-up's `POST /api/platform/public/signup` and `GET /api/platform/public/signup/:id/status` — see BILLING.md → *Self-serve sign-up*)
(`src/platform/routes/platformRoutes.js`). Its accounts (`super_admins`) and
session token are separate from every gym's.

Demo requests are de-duplicated per **email and kind** inside a ten-minute
window: a checkout (`kind: 'trial'`) after a demo request is a new record; a
second checkout inside the window updates the first one's plan, cycle,
add-ons, preferred slug and message and answers 201 with its id. Checkout
stores `firstName` / `lastName` separately (the owner account is created from
them) beside the single `name`. An add-on priced in another currency than the
plan is left off and noted in the request's `warnings`.

* **Overview** — gyms, subscription states, renewals due, MRR
* **Gyms** — list with live numbers from each gym's database; per gym:
  domains, plan & subscription, suspend/reactivate, administrators, reset
  owner password, delete (optionally dropping the database)
* **Plans** — what you sell: prices, limits, trial length
* **Audit log** — who did what to which gym

## Setting up

```bash
# 1. Register the gym that already exists (its data stays where it is)
node scripts/platform/registerExistingGym.js --name "Demo Gym" --slug demo --db GymPilot \
     --domain demogym.example --domain localhost:3000 --timezone Asia/Karachi --currency PKR
#    then in .env:  DEFAULT_TENANT_SLUG=demo   (single-gym / dev only)

# 2. A super admin
node scripts/platform/createSuperAdmin.js you@yourcompany.com "a strong password" --name "You"
#    (or set SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD: created on first sign-in)

# 3. New gyms: the panel's "New gym" form, or
node scripts/platform/provisionGym.js --name "Iron Works" --domain ironworks.com \
     --owner-email owner@ironworks.com --owner-password "..." --timezone Europe/London --currency GBP --plan starter

node scripts/platform/listGyms.js [--stats]
node scripts/platform/deleteGym.js --gym <slug> --confirm <slug> [--drop-database]

# Moving the platform collections between databases (one-off)
node scripts/platform/movePlatformData.js --from gympilot_platform --to GymPilot [--drop-source]

# Renaming the main database (copy, switch .env, verify, then drop the old one)
node scripts/platform/copyDatabase.js --from <old> --to <new> [--dry-run]
```

Provisioning creates the database, the system roles, a settings row with the
gym's name, website, currency (any ISO code) and country (ISO-2 only), the
homepage sections, the legal pages, and the owner's administrator account
(`src/platform/provisioning.js`). If any step fails the platform record is
rolled back **and the database is dropped when this run created it** (a
database that existed before, a dedicated-URI one, or one whose existence
could not be checked is left alone).

Rules the API applies to `POST /api/platform/gyms` (`validateDatabaseInput`;
the scripts that adopt an existing deployment are exempt):

* `database.name` may not be the platform database and must start with the
  tenant prefix (`TENANT_DB_PREFIX`) → otherwise `400`.
* `database.uri` is refused unless `ALLOW_DEDICATED_DB_URI=1` → `400`.
* An explicit `slug` from the reserved list (`api www app admin mail platform
  static assets cdn help support docs blog status login checkout panel`) →
  `400`; a *preferred* slug or gym name that lands on one gets a number on
  the end instead, like any taken name.

**The owner's email.** After a successful provisioning (and from
`POST /gyms/:id/reset-owner-password`) the owner is emailed the gym's name,
the sign-in address (`<siteUrl>/authentication`), their email, and a
**set-password link** — the same single-use hashed token the site's
forgot-password flow issues (`src/platform/ownerInvite.js`, link
`/authentication?mode=reset&token=…&email=…`, valid `OWNER_INVITE_TTL_HOURS`,
default 72). The password never travels. A delivery problem is never a 500:
the response carries `ownerInviteSent: false` and
`warnings: ['Owner email could not be sent']`. `reset-owner-password` without
a `password` only re-sends the link ("Resend owner invite" in the panel);
with one it sets the password *and* sends the link.

### Domains

Point the gym's domain at the website deployment (on Vercel: add it to the
frontend project). Add the same domain to the gym in the panel. That is all;
the API allows the origin and serves the gym's database from the next request.

When `PLATFORM_ROOT_DOMAIN` is set, provisioning also registers
`<slug>.<root>` as a domain of the new gym (primary only when the gym has no
other domain) and, when `VERCEL_TOKEN` / `VERCEL_PROJECT_ID` are set, adds it
to the Vercel project best-effort (a failure is a `warning` on the response,
not an error). `GET /api/platform/gyms/:id/domains/status` reports each
domain's Vercel state (on the project, verified, misconfigured, DNS record to
add); the panel shows it on the gym page.

### Environment

See `.env.example`: `PLATFORM_DB_NAME` and `TENANT_DB_PREFIX` (both optional,
derived from `MONGO_URI`), `DEFAULT_TENANT_SLUG`, `PLATFORM_ROOT_DOMAIN`, `PLATFORM_JWT_SECRET`,
`PLATFORM_TOKEN_TTL`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`,
`PLATFORM_ADMIN_ORIGIN`, `SUBSCRIPTION_GRACE_DAYS`; and for the pieces above:
`ALLOW_DEDICATED_DB_URI` (`1` to accept `database.uri` from the panel),
`PLATFORM_NAME` (branding on platform emails, default `GymsPilotPro`),
`PLATFORM_CONTACT_EMAIL` (shown to gym admins on their billing page),
`OWNER_INVITE_TTL_HOURS` (default 72).

### Scripts and seeders

Every script that touches gym data takes `--gym <slug>` (or uses
`DEFAULT_TENANT_SLUG`):

```bash
node scripts/expireMemberships.js --gym demo --apply
node scripts/sendReminders.js --gym demo --send
node scripts/attendanceAccess.js --gym demo grant desk@demogym.example --enroll
npm run seed:classes -- --gym demo-gym
```

The daily cron (`/api/jobs/reminders`) rolls platform subscriptions
(`active → past_due → expired` after `SUBSCRIPTION_GRACE_DAYS`), emails gym
owners whose trial is ending or whose payment is late
(`sendOwnerBillingNotices`, see BILLING.md → *Platform billing*), and then
runs the reminders for every active gym it can fit in its time budget, a few
side by side; any left over go first on the next run (FEATURES.md → *Daily
job*). A second cron (`/api/jobs/backups`, an hour earlier) stores an
encrypted backup of every active gym the same way (FEATURES.md → *Daily
backup*); the list of them is kept in the platform database
(`platform_backups`), never in the gym's own.

### The front-desk app

`desktopApp.config.json` gains `"gymDomain": "yourgym.com"`, sent as
`X-Tenant-Host` on every request. Leave it empty only on a single-gym server
with `DEFAULT_TENANT_SLUG` set.

## Per gym, now

* **Stripe** — each gym's keys and webhook secret live in its Settings; the
  per-gym webhook URL is `/api/gymfolio/payment/webhook/<slug>`. See
  BILLING.md. The platform env keys apply only to the `DEFAULT_TENANT_SLUG`
  gym.
* **Currency & timezone** — any ISO currency; the timezone is edited on
  Settings → General and stored on the gym's platform record.
* **Fingerprint and face encryption keys** — derived per gym (SECURITY_AND_DATA.md).

## Also see

BILLING.md · SECURITY_AND_DATA.md · KIOSK.md · scripts/backupGym.js
