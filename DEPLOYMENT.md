# Deploying GymsPilotPro

What has to be true in production for the API to run as it should, and the
order to do things in for this release (*Deploying this release*, at the
end). Everything here is a setting, a dashboard step or a script to run;
none of it is code.

## 1. Backend environment (Vercel → Project → Settings → Environment Variables)

| Variable | Value | Why |
|---|---|---|
| `DEFAULT_TENANT_SLUG` | `demo` **for now** | A request that names no gym is served the demo gym, and that gym keeps using the env `STRIPE_*` keys and `FRONTEND_ORIGIN`. Unset it once the demo gym has its own Stripe keys in Settings → Stripe and you run real gyms beside it — **but only after** `LEGACY_KEY_TENANT_SLUG` below is set. |
| `LEGACY_KEY_TENANT_SLUG` | `demo`, **permanently** | Names the gym whose stored secrets (Stripe, SMTP, SMS/WhatsApp tokens, push VAPID key under Settings) and fingerprint templates were encrypted before keys carried a gym id — the demo gym, which started life as the single-gym install. While unset it falls back to `DEFAULT_TENANT_SLUG`, so nothing changes until that is removed — and unsetting `DEFAULT_TENANT_SLUG` without this set re-keys that gym: every one of those secrets silently reads back empty (card payments and email stop) and no desk can match a single finger. It follows the gym's slug, so set it again if the slug is ever changed. |
| `SETTINGS_ENCRYPTION_KEY` | the **current** `JWT_SECRET` value, copied | Seals each gym's Settings secrets at rest. While unset it falls back to `JWT_SECRET`, so rotating `JWT_SECRET` would turn every stored Stripe key, SMTP password and messaging token into an empty value. Copying today's `JWT_SECRET` here keeps them readable and frees `JWT_SECRET` to be rotated later. Never change it once set. |
| `PLATFORM_DB_NAME` | leave unset (= `GymPilot`, the `MONGO_URI` database) | Gyms, plans and super admins live in the main database beside the first gym's data. |
| `TENANT_DB_PREFIX` | leave unset (= `GymPilot_`) | New gyms get `GymPilot_<slug>` on the same cluster. |
| `PLATFORM_JWT_SECRET` | a fresh random 64-char string | Signs super-admin sessions separately from gym sessions. |
| `QR_TOKEN_SECRET` | a fresh random 64-char string | Signs members' check-in QR codes. |
| `PLATFORM_ADMIN_ORIGIN` | e.g. `https://gymspilotpro.com` (comma separated for more than one, e.g. with and without `www`). **Required in production** | Where the marketing site + platform panel (`GymPilot_marketing`) is served; used for CORS, password-reset links, demo-request emails and — for a self-serve sign-up — where Stripe sends the buyer back. Links use the first origin listed. In production nothing stands in for it: without it a super admin's "forgot password" answers 503, self-serve sign-up stays off, and emails to the platform admins carry no link to the panel. |
| `PLATFORM_ROOT_DOMAIN` | e.g. `gympilot.app` | Every new gym is also registered as `<slug>.<this domain>`, and its owner's invite points there. **Self-serve sign-up needs it**: without it checkout sends a request for the panel instead of taking payment. |
| `PLATFORM_SELF_SERVE_SIGNUP` | leave unset | Checkout takes payment and builds the gym itself whenever the prerequisites hold — `PLATFORM_ROOT_DOMAIN`, `PLATFORM_ADMIN_ORIGIN`, the platform's Stripe keys with charging on, its webhook signing secret, and `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` that the mail server actually accepts (it is asked; the owner's set-password link goes out by email) (§2; BILLING.md → *Self-serve sign-up*). Set `off` to send every new gym through the panel regardless. |
| `SUBSCRIPTION_GRACE_DAYS` | `7` | Days a gym is served after its platform subscription lapses. |
| `FINGERPRINT_ENCRYPTION_KEY` | if already set: **leave as it is**; if unset: the **current** `JWT_SECRET` value, copied | Encrypts fingerprint templates at rest, falling back to `JWT_SECRET` while unset. Existing templates were encrypted with whichever secret was in effect when they were enrolled; changing it makes them all unreadable (`/api/desktop/templates` then counts them as `unreadable`, and every enrolled person must be enrolled again). Copying today's `JWT_SECRET` in keeps them readable and decouples them from it. |
| `JWT_SECRET` | **do not rotate** until the two keys above are set | Rotating it signs everyone out — and, while `SETTINGS_ENCRYPTION_KEY` or `FINGERPRINT_ENCRYPTION_KEY` is unset, also makes the data that key protects unreadable. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | working credentials | The platform's own mail: owner invites, billing notices, super-admin sign-in codes and resets, and every gym that has set no SMTP of its own under Settings → Email. If the mail server rejects them (a `535`), none of that is sent — 2FA codes, password resets and email-confirmation links included — and self-serve sign-up stays off. |
| `CRON_SECRET` | already set | The daily job now also rolls platform subscriptions, resumes freezes and closes visits nobody checked out of (FEATURES.md → *Daily job*). The daily backup (`/api/jobs/backups`, 02:00 UTC) uses the same secret. |
| `DAILY_JOB_BUDGET_MS` | `45000` (default) for a 60-second function; `240000` for a 300-second one | How long after the cron fired the daily job still starts new gyms. Gyms already running are left to finish, so keep it below the function's maximum duration by about one gym's run. Gyms not reached are listed under `schedule.deferred` and go first on the next run. |
| `DAILY_JOB_CONCURRENCY` | `3` (default; 1–10) | Gyms the daily job works on side by side. |
| `BLOB_READ_WRITE_TOKEN` | the Vercel Blob store's read-write token | Vercel has no writable disk: without it every upload fails there ("set BLOB_READ_WRITE_TOKEN"). It is also what lets the admin pages send a file too big for the API straight to the store (`POST /api/uploads/blob`), and where the daily backups are kept. |
| `BACKUP_ENCRYPTION_KEY` | a fresh random 64-char string, **never changed** once set | Encrypts every stored backup (the Blob store is public). No fallback on purpose: without it the daily backup stores nothing and says so, and owners see "daily backups are not running". Changing it makes every backup stored before unreadable. Keep a copy somewhere other than Vercel: a backup is only as recoverable as its key. |
| `BACKUP_KEEP_DAILY` | `7` (default; 1–90) | Stored backups kept per gym, of each kind (daily, "back up now", taken before a restore). |
| `UPLOAD_MAX_FILE_SIZE_MB` / `UPLOAD_MAX_VIDEO_SIZE_MB` | `5` / `100` (defaults) | Per-file ceilings for images and videos through the API. On Vercel anything sent through the API stops at **4 MB** whatever these say (Vercel refuses bodies over 4.5 MB). Bigger files go straight to Blob when the token is set: images up to 20 MB, videos up to `UPLOAD_MAX_VIDEO_SIZE_MB`. |

Generate secrets with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**Function time limit.** `vercel.json` sets no maximum duration, so the API
runs with the project's (Vercel → Project → Settings → Functions). Two things
run long inside one request: the daily job, which paces itself by
`DAILY_JOB_BUDGET_MS`, and a self-serve sign-up's webhook, which builds a
whole gym before it answers. The daily backup paces itself by the same
budget, and a restore (Settings → Data & backup) rewrites a whole gym inside
one request. Give the function as long as the plan allows and set
`DAILY_JOB_BUDGET_MS` to match.

Everything else the API reads, with its default or an example in `.env.example`:

| Variable(s) | Notes |
|---|---|
| `MONGO_URI` | The cluster and the main database (see MULTI_TENANCY.md). |
| `FRONTEND_ORIGIN`, `GYMFOLIO_URL`, `EXTRA_CORS_ORIGINS` | CORS. `FRONTEND_ORIGIN` is also the website address of the `DEFAULT_TENANT_SLUG` gym, and the last fallback for a gym with neither a domain nor a platform subdomain. |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Only for the `DEFAULT_TENANT_SLUG` gym (§2). |
| `EMAIL_FROM`, `SITE_NAME` | Sender line for the env SMTP transport; the name emails fall back to when a gym has no site name yet. |
| `PLATFORM_NAME`, `PLATFORM_CONTACT_EMAIL` | Branding on platform emails (default `GymsPilotPro`); the address gym admins are shown on their Billing tab. |
| `PLATFORM_TOKEN_TTL`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | Super-admin session length (default `12h`); the first super admin, created on the first sign-in attempt when none exists. |
| `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | Domains added to the website project for you (§3). |
| `ALLOW_DEDICATED_DB_URI`, `OWNER_INVITE_TTL_HOURS` | `1` to accept a gym on its own cluster; how long the owner's set-password link lasts (default 72 hours). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google sign-in, offered only when all three are set. |
| `ATTENDANCE_*`, `FINGERPRINT_FAR` | Front-desk rules: timezone fallback, punch gap, open-visit window (and the shorter staff window: `ATTENDANCE_STAFF_SHIFT_GRACE_HOURS`, `ATTENDANCE_STAFF_OPEN_HOURS`), late grace, expiry warning, match threshold. |
| `MEMBERSHIP_REMINDER_DAYS`, `ACCOUNTS_CURRENCY` | Expiry-notice days (default `14,7,1`); the accounts currency when a gym has none. |
| `EXPO_ACCESS_TOKEN` | Only when the Expo project has enhanced push security on. |
| `IMPORT_BUDGET_MS` | How long a member import (Users → Import CSV) goes on starting new rows before it stops cleanly and says how many are left; the same file uploaded again carries on. Default `40000`, for a 60-second function. Keep it a few seconds below the function's time limit. |
| `API_PUBLIC_URL` | Optional. The API's own public address (`https://api.yourgym.com`), used for the link in "confirm your email" messages. Unset, the link is built from the address the request came in on; set it when something in front of the API passes any `Host` header through. |
| `PORT`, `NODE_ENV`, `VERCEL` | `NODE_ENV=production` comes from `vercel.json`; `VERCEL` is set by Vercel itself and turns on the 4 MB upload cap. |

`ADMIN_EMAIL` / `ADMIN_PASSWORD` are read only by `Seeder/createAdmin.js`,
`SEED_PASSWORD` only by `Seeder/createAttendance.js` (the password its sample
accounts get), and `GYMPILOT_INTEGRATION_REQUIRED` only by the integration
tests (FEATURES.md → *Tests*); none belongs on the server.

## 2. Stripe

**The platform's own account** — what gyms pay GymsPilotPro through, and what a
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
* For the demo gym, while `DEFAULT_TENANT_SLUG=demo`, the env keys apply and
  the existing `/api/gymfolio/payment/webhook` endpoint keeps working.
* Before unsetting `DEFAULT_TENANT_SLUG`: set `LEGACY_KEY_TENANT_SLUG=demo`
  and redeploy, then check the demo gym's Settings → Stripe / Email still show
  their keys and a front desk still matches fingers. Only then unset
  `DEFAULT_TENANT_SLUG`.

## 3. Frontend (Vercel)

* Add every gym's domain to the gym in the platform panel (`<PLATFORM_ADMIN_ORIGIN>/super-admin`). With `VERCEL_TOKEN`
  and `VERCEL_PROJECT_ID` set on the API, the domain is added to the
  frontend project for you and the panel shows the DNS record to create;
  without them, add it under the project's Settings → Domains by hand.
* `NEXT_PUBLIC_BACKEND_URL` unchanged.

## 4. Front-desk PCs

Build the desk app from `GymPilot_desktopApp` (`build.cmd`; its README has
the steps), copy the resulting `bin/` folder to each desk and set
`"gymDomain": "<the gym's domain>"` in `desktopApp.config.json` beside the
exe. Two things an older build lacks: the consent checkbox — fingerprint
enrolment from it answers `409 CONSENT_REQUIRED` unless the member agreed
online or staff recorded consent under Users — and the punch `request_id`
(KIOSK.md), without which a punch whose answer was lost and is scanned again
more than a minute later is taken for the check-out. Desks can be updated
after the API: an older build keeps working with this release.

## 5. After the first deploy

1. Deploy `GymPilot_marketing` (marketing site + platform panel) with `NEXT_PUBLIC_BACKEND_URL` and `NEXT_PUBLIC_SITE_URL` set, and put its origin in the API's `PLATFORM_ADMIN_ORIGIN`. Sign in at `<that origin>/super-admin` with the super admin you created (`scripts/platform/createSuperAdmin.js`); change the password under **My account** and turn on two-factor once SMTP works.
2. Create your platform plans (**Plans**) and put the demo gym on one.
3. Provision new gyms from **Gyms → New gym**; each owner lands in the setup
   wizard at `/admin/setup`. Gyms can also sign up and pay on their own at
   `<PLATFORM_ADMIN_ORIGIN>/checkout` once `PLATFORM_ROOT_DOMAIN` and the
   platform's Stripe account (§2) are set up: `GET /api/platform/public/config`
   answers `self_serve_signup: true` when they are. Until then checkout sends
   a request to **Demo requests** for you to set up.
4. Backups: with `BLOB_READ_WRITE_TOKEN` and `BACKUP_ENCRYPTION_KEY` set, the
   `vercel.json` cron backs up every gym at 02:00 UTC (FEATURES.md → *Daily
   backup*); check the first run with
   `curl -H "Authorization: Bearer $CRON_SECRET" "https://<api>/api/jobs/backups?dryRun=1"`.
   Those copies live in the same Vercel account as everything else, so also
   run `node scripts/backupGym.js --all --out /some/where` somewhere else now
   and then (cron or a GitHub Action) — it is the only copy of the platform's
   own collections. Each gym's owner can download the whole gym at any time
   from Settings → Data & backup (SECURITY_AND_DATA.md → *Backups*).

## 6. Deploying this release

**Pushing `main` deploys.** The API's Vercel project is linked to the Git
repository, so a push to `main` goes to production — there is no separate
"deploy" step to forget, and none to hold back. Do steps 1–3 below first,
with §1 (environment) and §2 (Stripe) already in place: a gym whose
Settings still hold placeholder Stripe keys cannot take card payments.
Before pushing, run `npm test` and `npm run test:integration`; in CI set
`GYMPILOT_INTEGRATION_REQUIRED=1` so an integration suite that cannot start
fails rather than skips (FEATURES.md → *Tests*).

1. **Backups key.** Set `BACKUP_ENCRYPTION_KEY` (§1) and keep a copy of it
   somewhere other than Vercel. Never change it afterwards: every backup
   stored before would be unreadable.
2. **The platform's email.** Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASS` and `EMAIL_FROM` to credentials the mail server accepts, and
   check `PLATFORM_ADMIN_ORIGIN` is set (§1).
3. **Once per gym, from a checkout of this release** with the production
   `MONGO_URI` in `.env`. Each is a dry run until `--apply` is added: read
   what it reports, then run it again with `--apply`. All four are safe to
   run twice.

       node scripts/migrateEmailIndex.js --gym <slug>     # or --all
       node scripts/assignMemberCodes.js --gym <slug>     # or --all
       node scripts/backfillOrderFees.js --gym <slug>     # one gym at a time
       node scripts/cleanHomeSeed.js     --gym <slug>     # or --all

   In turn: lets a gym hold more than one member without an email; gives
   every older member a member ID; records the joining fee on orders from
   before it was kept apart (BILLING.md); takes the old made-up homepage
   text, figures and stock photos off gyms created before the defaults were
   rewritten — only where the gym never changed them, and the dry run lists
   each line it would replace.
4. **Deploy the API**: push `main`.
5. **Check it.** `GET https://<api>/health` answers `200`.
   `GET https://<api>/api/jobs/backups` with no `Authorization` header
   answers `401` (a `503` means `CRON_SECRET` is not set, and no scheduled
   job will run). Vercel → Project → Settings → Cron Jobs lists two:
   `/api/jobs/backups` at 02:00 UTC and `/api/jobs/reminders` at 03:00 UTC.
6. **Deploy the two web apps**, `GymPilot_frontend` and
   `GymPilot_marketing`, after the API: they use what this release adds.
7. Front-desk PCs (§4) in their own time.

### Rolling back

In Vercel → Deployments, open the last deployment that worked and choose
**Promote to Production** (Instant Rollback). That changes no code in Git:
the next push to `main` deploys again, so revert or fix the commit before
pushing. Roll the two web apps back with the API — the new contact form,
for one, sends categories an older API refuses.

Nothing the steps above did needs undoing. What the four scripts wrote is
ordinary data that older code reads as it is, and the fields this release
writes (an order's `imported` mark, request ids, email confirmation) are
simply not looked at by it. Leave the environment variables set — above all
`BACKUP_ENCRYPTION_KEY`, which must stay exactly as it is for the backups
already stored. What a rollback does bring back is the old behaviour, until
this release is deployed again: an imported membership counts as money taken
on the day it was imported, a punch or an "Add member" sent twice is
recorded twice, and an account's unconfirmed email is trusted.
