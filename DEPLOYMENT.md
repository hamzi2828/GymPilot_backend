# Deploying GymPilot

What has to be true in production before the `feat/platform-billing-security`
branches go live. Everything here is a setting or a dashboard step; none of
it is code.

## 1. Backend environment (Vercel → Project → Settings → Environment Variables)

| Variable | Value | Why |
|---|---|---|
| `DEFAULT_TENANT_SLUG` | `thejymor` **for now** | The pre-platform gym keeps using the env `STRIPE_*` keys and `FRONTEND_ORIGIN` only while it is the default gym. Unset it once The Jymor has its own Stripe keys in Settings → Stripe and you run more than one gym. |
| `PLATFORM_DB_NAME` | leave unset (= `GymPilot`, the `MONGO_URI` database) | Gyms, plans and super admins live in the main database beside the first gym's data. |
| `TENANT_DB_PREFIX` | leave unset (= `GymPilot_`) | New gyms get `GymPilot_<slug>` on the same cluster. |
| `PLATFORM_JWT_SECRET` | a fresh random 64-char string | Signs super-admin sessions separately from gym sessions. |
| `QR_TOKEN_SECRET` | a fresh random 64-char string | Signs members' check-in QR codes. |
| `PLATFORM_ADMIN_ORIGIN` | e.g. `https://gympilot.app` | Where the marketing site + platform panel (`GymPilot_frontendAdmin`) is served; used for CORS, password-reset links and demo-request emails. |
| `SUBSCRIPTION_GRACE_DAYS` | `7` | Days a gym is served after its platform subscription lapses. |
| `FINGERPRINT_ENCRYPTION_KEY` | **leave as it is** | Existing templates were encrypted with the current secret (JWT_SECRET fallback). Changing it makes them unreadable. |
| `SMTP_*` | working credentials | The current ones are rejected (`535`). Nothing emails until this is fixed — including 2FA codes and password resets. |
| `CRON_SECRET` | already set | The daily job now also rolls platform subscriptions and resumes freezes. |

Generate secrets with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 2. Stripe (each gym's own dashboard)

* Keys under the gym's **Settings → Stripe**; webhook endpoint
  `https://<api>/api/gymfolio/payment/webhook/<slug>` (shown on that screen)
  with events `checkout.session.completed, invoice.paid, invoice.payment_failed,
  customer.subscription.updated, customer.subscription.deleted,
  payment_intent.succeeded, payment_intent.payment_failed`.
* **Billing → Customer portal**: activate the default configuration once, or
  "Manage card" in the member portal fails.
* For The Jymor, while `DEFAULT_TENANT_SLUG=thejymor`, the env keys apply and
  the existing `/api/gymfolio/payment/webhook` endpoint keeps working.

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
   wizard at `/admin/setup`.
4. Schedule backups: `node scripts/backupGym.js --all --out /some/where` (cron
   or a GitHub Action) and copy the folder off the server.

## 6. Merging

The branches were pushed but not merged into `main`: merging deploys to
production, and steps 1–2 must be done first or card payments on the live
site break (the gym's Settings hold placeholder Stripe keys). Open the pull
requests from the branch pages on GitHub when ready.
