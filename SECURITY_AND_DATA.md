# Security, sessions & members' data

## Sessions

Gym JWTs (7 days) carry `tid` (the gym that issued them) and `tv` (the
account's `tokenVersion`). `src/middleware/auth.js` checks both on every
request, re-reading the account at most every 30 seconds per process:

* a token from one gym is refused on another gym's site;
* a deactivated account is out within 30 seconds;
* bumping `tokenVersion` ends every session at once — `POST /user/logout-all`
  (the member, from **Security & privacy** on their account page), a
  password change or reset, or staff **Sign out** on the Users screen
  (`POST /admin/users/:id/logout-all`).

Platform (super admin) tokens have their own secret and are refused by every
gym endpoint.

## Two-factor sign-in

An emailed six-digit code (`src/services/twoFactorService.js`), single-use,
10 minutes, five attempts. Applies to:

* anyone who switches it on for their own account (`PUT /user/two-factor`);
* every staff account when **Settings → Two-factor authentication** is on.

`POST /user/login` answers `{ requires2fa, challengeId }` instead of a token;
`POST /user/login/2fa { challengeId, code }` completes it. Switching it on is
refused while outgoing email is not working, because the code cannot arrive.
The Windows attendance app and the web kiosk sign in through
`/api/desktop/login`, which is gated by `allowAttendanceApp` instead.

## Admin audit log

Every write that passes a permission gate (`src/middleware/requirePermission.js`)
is recorded after the response — who, method, path, area, status, and a
summary of the body with credential-like fields hidden. **System → Audit log**
(`GET /admin/audit-log`), permission tab `audit`.

## Biometric consent

A fingerprint template is biometric data. Nothing is stored until the person
has agreed:

* the member ticks **I agree** under Security & privacy on their account
  page (`PUT /user/consents { biometric: true }`);
* or staff record a signed form with **Consent** on the Users screen
  (`PUT /admin/users/:id/consent`);
* or the desk ticks the consent box in the attendance app's enrol form
  (sent as `consent: true` to `/api/desktop/enroll`).

Without any of those, enrolment answers `409 CONSENT_REQUIRED`. Withdrawing
consent deletes the stored templates. Templates are encrypted with a key
derived per gym (`FINGERPRINT_ENCRYPTION_KEY`, salted with the gym id; the
pre-platform gym keeps its original key).

## A copy of their data

`GET /user/export` — the member's account, memberships, bookings, visits,
fingerprint metadata (not the templates) and enquiries as a JSON download;
**Download my data** on the account page.

## Backups

    node scripts/backupGym.js --gym <slug> [--out backups]
    node scripts/backupGym.js --all

One gzipped JSON-lines file per collection plus a manifest, under
`backups/<slug>/<timestamp>/`. Restore with `mongoimport --gzip`. Copy the
folder off the server; schedule it with cron / Task Scheduler / a GitHub Action.

## Rate limits

Sign-in, password reset, sign-up, the desk app's sign-in and the 2FA code
endpoint are all rate-limited per address (`src/middleware/rateLimit.js`).
