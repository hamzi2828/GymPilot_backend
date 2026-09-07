# GymPilot multi-tenancy

One backend, one website deployment, one front-desk app — and **one database
per gym**. A gym is served on its own domain(s); the platform owner manages
every gym from a super-admin panel.

```
 gymA.com ─┐                                 ┌─ MongoDB  gympilot_gyma
 gymB.com ─┤   Next.js site (one deploy)     ├─ MongoDB  gympilot_gymb
 gymC.com ─┘          │                      ├─ MongoDB  gymwear        (the original gym)
                      ▼  Origin / X-Tenant-Host
              GymPilot_backend ───────────────┤
              /api/platform  (super admin)    └─ MongoDB  gympilot_platform
                                                  gyms · platform_plans · super_admins · platform_audit_logs
```

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
* **Links in emails and redirects** (`frontendOrigin()`) come from the
  gym's *registered* domain, never from a raw header.
* **Timezone** comes from `gym.locale.timezone` (`timeUtils.timezone()`), so
  attendance, timetables and reminders run on each gym's clock.
* **Uploads** land in `uploads/<slug>/…` (disk) or `<slug>/<folder>/…` (Vercel Blob).
* **Caches** that used to be per-process — roles, email branding, ledger
  currency, membership-expiry sweep, desktop login throttle — are keyed per gym.
* **Plan limits** (`src/platform/planLimits.js`): members, staff, trainers,
  classes — checked on creation; 0 = unlimited.

## The platform panel

Website: `/super-admin` (login at `/super-admin/login`). API: `/api/platform/*`
(`src/platform/routes/platformRoutes.js`). Its accounts (`super_admins`) and
session token are separate from every gym's.

* **Overview** — gyms, subscription states, renewals due, MRR
* **Gyms** — list with live numbers from each gym's database; per gym:
  domains, plan & subscription, suspend/reactivate, administrators, reset
  owner password, delete (optionally dropping the database)
* **Plans** — what you sell: prices, limits, trial length
* **Audit log** — who did what to which gym

## Setting up

```bash
# 1. Register the gym that already exists (its data stays where it is)
node scripts/platform/registerExistingGym.js --name "The Jymor" --slug thejymor --db gymwear \
     --domain thejymor.com --domain localhost:3000 --timezone Asia/Karachi --currency PKR
#    then in .env:  DEFAULT_TENANT_SLUG=thejymor   (single-gym / dev only)

# 2. A super admin
node scripts/platform/createSuperAdmin.js you@yourcompany.com "a strong password" --name "You"
#    (or set SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD: created on first sign-in)

# 3. New gyms: the panel's "New gym" form, or
node scripts/platform/provisionGym.js --name "Iron Works" --domain ironworks.com \
     --owner-email owner@ironworks.com --owner-password "..." --timezone Europe/London --currency GBP --plan starter

node scripts/platform/listGyms.js [--stats]
node scripts/platform/deleteGym.js --gym <slug> --confirm <slug> [--drop-database]
```

Provisioning creates the database, the system roles, a settings row with the
gym's name and website, the homepage sections, the legal pages, and the
owner's administrator account (`src/platform/provisioning.js`). If any step
fails the platform record is rolled back.

### Domains

Point the gym's domain at the website deployment (on Vercel: add it to the
frontend project). Add the same domain to the gym in the panel. That is all;
the API allows the origin and serves the gym's database from the next request.

### Environment

See `.env.example`: `PLATFORM_DB_NAME`, `TENANT_DB_PREFIX`,
`DEFAULT_TENANT_SLUG`, `PLATFORM_ROOT_DOMAIN`, `PLATFORM_JWT_SECRET`,
`PLATFORM_TOKEN_TTL`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`,
`PLATFORM_ADMIN_ORIGIN`, `SUBSCRIPTION_GRACE_DAYS`.

### Scripts and seeders

Every script that touches gym data takes `--gym <slug>` (or uses
`DEFAULT_TENANT_SLUG`):

```bash
node scripts/expireMemberships.js --gym thejymor --apply
node scripts/sendReminders.js --gym thejymor --send
node scripts/attendanceAccess.js --gym thejymor grant desk@thejymor.com --enroll
npm run seed:classes -- --gym demo-gym
```

The daily cron (`/api/jobs/reminders`) rolls platform subscriptions
(`active → past_due → expired` after `SUBSCRIPTION_GRACE_DAYS`) and then runs
the reminders for every active gym.

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
* **Fingerprint encryption key** — derived per gym (SECURITY_AND_DATA.md).

## Also see

BILLING.md · SECURITY_AND_DATA.md · KIOSK.md · scripts/backupGym.js
