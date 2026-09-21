# Deploying GymPilot

What has to be true in production before the `feat/platform-billing-security`
branches go live. Everything here is a setting or a dashboard step; none of
it is code.

## 1. Backend environment (Vercel → Project → Settings → Environment Variables)

| Variable | Value | Why |
|---|---|---|
| `DEFAULT_TENANT_SLUG` | `thejymor` **for now** | The pre-platform gym keeps using the env `STRIPE_*` keys and `FRONTEND_ORIGIN` only while it is the default gym. Unset it once The Jymor has its own Stripe keys in Settings → Stripe and you run more than one gym — **but only after** `LEGACY_KEY_TENANT_SLUG` below is set. |
| `LEGACY_KEY_TENANT_SLUG` | `thejymor`, **permanently** | Names the gym whose stored secrets (Stripe, SMTP, SMS/WhatsApp tokens, push VAPID key under Settings) and fingerprint templates were encrypted before keys carried a gym id. While unset it falls back to `DEFAULT_TENANT_SLUG`, so today nothing changes — but unsetting `DEFAULT_TENANT_SLUG` without it re-keys The Jymor: every one of those secrets silently reads back empty (card payments and email stop) and no desk can match a single finger. Set it before touching `DEFAULT_TENANT_SLUG`, and never change or remove it. |
| `SETTINGS_ENCRYPTION_KEY` | the **current** `JWT_SECRET` value, copied | Seals each gym's Settings secrets at rest. While unset it falls back to `JWT_SECRET`, so rotating `JWT_SECRET` would turn every stored Stripe key, SMTP password and messaging token into an empty value. Copying today's `JWT_SECRET` here keeps them readable and frees `JWT_SECRET` to be rotated later. Never change it once set. |
| `PLATFORM_DB_NAME` | leave unset (= `GymPilot`, the `MONGO_URI` database) | Gyms, plans and super admins live in the main database beside the first gym's data. |
| `TENANT_DB_PREFIX` | leave unset (= `GymPilot_`) | New gyms get `GymPilot_<slug>` on the same cluster. |
| `PLATFORM_JWT_SECRET` | a fresh random 64-char string | Signs super-admin sessions separately from gym sessions. |
| `QR_TOKEN_SECRET` | a fresh random 64-char string | Signs members' check-in QR codes. |
| `PLATFORM_ADMIN_ORIGIN` | e.g. `https://gympilot.app` (comma separated for more than one, e.g. with and without `www`) | Where the marketing site + platform panel (`GymPilot_frontendAdmin`) is served; used for CORS, password-reset links, demo-request emails and — for a self-serve sign-up — where Stripe sends the buyer back. Links use the first origin listed. |
| `PLATFORM_ROOT_DOMAIN` | e.g. `gympilot.app` | Every new gym is also registered as `<slug>.<this domain>`, and its owner's invite points there. **Self-serve sign-up needs it**: without it checkout sends a request for the panel instead of taking payment. |
| `PLATFORM_SELF_SERVE_SIGNUP` | leave unset | Checkout takes payment and builds the gym itself whenever the prerequisites hold — `PLATFORM_ROOT_DOMAIN`, the platform's Stripe keys with charging on, its webhook signing secret, and working `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` (the owner's set-password link goes out by email) (§2; BILLING.md → *Self-serve sign-up*). Set `off` to send every new gym through the panel regardless. |
| `SUBSCRIPTION_GRACE_DAYS` | `7` | Days a gym is served after its platform subscription lapses. |
| `FINGERPRINT_ENCRYPTION_KEY` | if already set: **leave as it is**; if unset: the **current** `JWT_SECRET` value, copied | Encrypts fingerprint templates at rest, falling back to `JWT_SECRET` while unset. Existing templates were encrypted with whichever secret was in effect when they were enrolled; changing it makes them all unreadable (`/api/desktop/templates` then counts them as `unreadable`, and every enrolled person must be enrolled again). Copying today's `JWT_SECRET` in keeps them readable and decouples them from it. |
| `JWT_SECRET` | **do not rotate** until the two keys above are set | Rotating it signs everyone out — and, while `SETTINGS_ENCRYPTION_KEY` or `FINGERPRINT_ENCRYPTION_KEY` is unset, also makes the data that key protects unreadable. |
| `SMTP_*` | working credentials | The current ones are rejected (`535`). Nothing emails until this is fixed — including 2FA codes and password resets. |
| `CRON_SECRET` | already set | The daily job now also rolls platform subscriptions, resumes freezes and closes visits nobody checked out of (FEATURES.md → *Daily job*). |
| `DAILY_JOB_BUDGET_MS` | `45000` (default) for a 60-second function; `240000` for a 300-second one | How long after the cron fired the daily job still starts new gyms. Gyms already running are left to finish, so keep it below the function's maximum duration by about one gym's run. Gyms not reached are listed under `schedule.deferred` and go first on the next run. |
| `DAILY_JOB_CONCURRENCY` | `3` (default; 1–10) | Gyms the daily job works on side by side. |
| `BLOB_READ_WRITE_TOKEN` | the Vercel Blob store's read-write token | Vercel has no writable disk: without it every upload fails there ("set BLOB_READ_WRITE_TOKEN"). It is also what lets the admin pages send a file too big for the API straight to the store (`POST /api/uploads/blob`). |
| `UPLOAD_MAX_FILE_SIZE_MB` / `UPLOAD_MAX_VIDEO_SIZE_MB` | `5` / `100` (defaults) | Per-file ceilings for images and videos through the API. On Vercel anything sent through the API stops at **4 MB** whatever these say (Vercel refuses bodies over 4.5 MB). Bigger files go straight to Blob when the token is set: images up to 20 MB, videos up to `UPLOAD_MAX_VIDEO_SIZE_MB`. |

Generate secrets with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**Function time limit.** `vercel.json` sets no maximum duration, so the API
runs with the project's (Vercel → Project → Settings → Functions). Two things
run long inside one request: the daily job, which paces itself by
`DAILY_JOB_BUDGET_MS`, and a self-serve sign-up's webhook, which builds a
whole gym before it answers. Give the function as long as the plan allows and
set `DAILY_JOB_BUDGET_MS` to match.

Everything else the API reads, with its default or an example in `.env.example`:

| Variable(s) | Notes |
|---|---|
| `MONGO_URI` | The cluster and the main database (see MULTI_TENANCY.md). |
| `FRONTEND_ORIGIN`, `GYMFOLIO_URL`, `EXTRA_CORS_ORIGINS` | CORS. `FRONTEND_ORIGIN` is also the website address of the `DEFAULT_TENANT_SLUG` gym, and the last fallback for a gym with neither a domain nor a platform subdomain. |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Only for the `DEFAULT_TENANT_SLUG` gym (§2). |
| `EMAIL_FROM`, `SITE_NAME` | Sender line for the env SMTP transport; the name emails fall back to when a gym has no site name yet. |
| `PLATFORM_NAME`, `PLATFORM_CONTACT_EMAIL` | Branding on platform emails (default `GymPilot`); the address gym admins are shown on their Billing tab. |
| `PLATFORM_TOKEN_TTL`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | Super-admin session length (default `12h`); the first super admin, created on the first sign-in attempt when none exists. |
| `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | Domains added to the website project for you (§3). |
| `ALLOW_DEDICATED_DB_URI`, `OWNER_INVITE_TTL_HOURS` | `1` to accept a gym on its own cluster; how long the owner's set-password link lasts (default 72 hours). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google sign-in, offered only when all three are set. |
| `ATTENDANCE_*`, `FINGERPRINT_FAR` | Front-desk rules: timezone fallback, punch gap, open-visit window (and the shorter staff window: `ATTENDANCE_STAFF_SHIFT_GRACE_HOURS`, `ATTENDANCE_STAFF_OPEN_HOURS`), late grace, expiry warning, match threshold. |
| `MEMBERSHIP_REMINDER_DAYS`, `ACCOUNTS_CURRENCY` | Expiry-notice days (default `14,7,1`); the accounts currency when a gym has none. |
| `EXPO_ACCESS_TOKEN` | Only when the Expo project has enhanced push security on. |
| `PORT`, `NODE_ENV`, `VERCEL` | `NODE_ENV=production` comes from `vercel.json`; `VERCEL` is set by Vercel itself and turns on the 4 MB upload cap. |

`ADMIN_EMAIL` / `ADMIN_PASSWORD` are read only by `Seeder/createAdmin.js`, and
`GYMPILOT_INTEGRATION_REQUIRED` only by the integration tests (FEATURES.md →
*Tests*); none belongs on the server.

## 2. Stripe

**The platform's own account** — what gyms pay GymPilot through, and what a
self-serve sign-up pays with (BILLING.md → *Platform billing*):

* Under the panel's **System → Stripe**: the secret key, charging switched
  on, and the signing secret of a webhook endpoint
  `https://<api>/api/platform/stripe/webhook` (shown on that screen) with
  events `checkout.session.completed, invoice.paid, invoice.payment_failed,
  customer.subscription.updated, customer.subscription.deleted`. Without the
  signing secret every event is refused — and self-serve sign-up stays off,
  since no payment could ever create its gym.
* **Billing → Customer portal**: activate the default configuration here too,
  or a gym's **Manage billing** fails.

**Each gym's own dashboard:**

* Keys under the gym's **Settings → Stripe**; webhook endpoint
  `https://<api>/api/gymfolio/payment/webhook/<slug>` (shown on that screen)
  with events `checkout.session.completed, invoice.paid, invoice.payment_failed,
  customer.subscription.updated, customer.subscription.deleted,
  payment_intent.succeeded, payment_intent.payment_failed`.
* **Billing → Customer portal**: activate the default configuration once, or
  "Manage card" in the member portal fails.
* For The Jymor, while `DEFAULT_TENANT_SLUG=thejymor`, the env keys apply and
  the existing `/api/gymfolio/payment/webhook` endpoint keeps working.
* Before unsetting `DEFAULT_TENANT_SLUG`: set `LEGACY_KEY_TENANT_SLUG=thejymor`
  and redeploy, then check The Jymor's Settings → Stripe / Email still show
  their keys and a front desk still matches fingers. Only then unset
  `DEFAULT_TENANT_SLUG`.

## 3. Frontend (Vercel)

* Add every gym's domain to the gym in the platform panel (`<PLATFORM_ADMIN_ORIGIN>/super-admin`). With `VERCEL_TOKEN`
  and `VERCEL_PROJECT_ID` set on the API, the domain is added to the
  frontend project for you and the panel shows the DNS record to create;
  without them, add it under the project's Settings → Domains by hand.
* `NEXT_PUBLIC_BACKEND_URL` unchanged.

## 4. Front-desk PCs

Copy the rebuilt `GymPilot_desktopApp/bin/` (built 2026-09-07) to each desk
and set `"gymDomain": "<the gym's domain>"` in `desktopApp.config.json`
beside the exe. The old build has no consent checkbox, so fingerprint
enrolment from it answers `409 CONSENT_REQUIRED` unless the member agreed
online or staff recorded consent under Users.

## 5. After the first deploy

1. Deploy `GymPilot_frontendAdmin` (marketing site + platform panel) with `NEXT_PUBLIC_BACKEND_URL` and `NEXT_PUBLIC_SITE_URL` set, and put its origin in the API's `PLATFORM_ADMIN_ORIGIN`. Sign in at `<that origin>/super-admin` with the super admin you created (`scripts/platform/createSuperAdmin.js`); change the password under **My account** and turn on two-factor once SMTP works.
2. Create your platform plans (**Plans**) and put The Jymor on one.
3. Provision new gyms from **Gyms → New gym**; each owner lands in the setup
   wizard at `/admin/setup`. Gyms can also sign up and pay on their own at
   `<PLATFORM_ADMIN_ORIGIN>/checkout` once `PLATFORM_ROOT_DOMAIN` and the
   platform's Stripe account (§2) are set up: `GET /api/platform/public/config`
   answers `self_serve_signup: true` when they are. Until then checkout sends
   a request to **Demo requests** for you to set up.
4. Schedule backups: `node scripts/backupGym.js --all --out /some/where` (cron
   or a GitHub Action) and copy the folder off the server.

## 6. Merging

The branches were pushed but not merged into `main`: merging deploys to
production, and steps 1–2 must be done first or card payments on the live
site break (the gym's Settings hold placeholder Stripe keys). Open the pull
requests from the branch pages on GitHub when ready. Run `npm test` and
`npm run test:integration` first; in CI set `GYMPILOT_INTEGRATION_REQUIRED=1`
so an integration suite that cannot start fails rather than skips
(FEATURES.md → *Tests*).
