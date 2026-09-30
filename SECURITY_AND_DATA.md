# Security, sessions & members' data

## Sessions

Gym JWTs last 7 days on the website, 30 days with **Remember me** ticked and
30 days in the phone app. They carry `tid` (the gym that issued them) and
`tv` (the account's `tokenVersion`). `src/middleware/auth.js` checks both on
every request, re-reading the account at most every 30 seconds per process:

* a token from one gym is refused on another gym's site;
* a deactivated account is out within 30 seconds;
* bumping `tokenVersion` ends every session at once — `POST /user/logout-all`
  (the member, from **Security & privacy** on their account page), a
  password change or reset, staff setting it (**Set password** on the Users
  and Staff screens, which also signs out the front-desk app), staff
  **Sign out** on the Users screen
  (`POST /admin/users/:id/logout-all`), and any change of role or of being
  on the staff list (the Users role picker, a Staff edit, removing someone
  from staff). A token names the role it was signed in with, so a demoted
  manager signs in again rather than keeping "manager" for weeks.

Google sign-in finds an account by email. Sign-up does not verify the email,
so the first time Google (which has) links into a password account that was
not made through Google, that password is cleared and its sessions end: a
stranger who pre-registered the address is shut out, and the owner can set a
password with **Forgot password**, which also works for accounts that have
only ever used Google. Google sign-in gets the same two-factor step as a
password.

Platform (super admin) tokens have their own secret and are refused by every
gym endpoint.

## Staff pay

Holding `staff: manage` does not let anyone below an administrator change
their own salary or bank details, record or decide their own leave, or edit,
issue or pay their own payslip — nor do any of those to an administrator
(`src/services/payGuards.js`). Paying a payslip is a single conditional
write, so it files one salary expense however many times it is submitted.

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

## Newsletter unsubscribe

Every unsubscribe link in a newsletter email carries a token: an HMAC of the
address and the gym, keyed from `JWT_SECRET` under its own purpose label
(`src/services/unsubscribeLinks.js`). `POST /api/newsletter/unsubscribe`
refuses an address without its token, so nobody can take somebody else off
the list, and the `/unsubscribe` page waits for a click rather than acting on
page load, so a mail scanner opening the link changes nothing. Rotating
`JWT_SECRET` invalidates links in emails already sent.

## Uploads

Images are JPEG, PNG, WebP or GIF — SVG is refused, since it can carry
script — and a stored file is named for the type that was checked, not the
name it arrived with. Limits: images 5 MB (`UPLOAD_MAX_FILE_SIZE_MB`), hero
images 20 MB, member documents 10 MB, CSV imports 5 MB, videos 100 MB
(`UPLOAD_MAX_VIDEO_SIZE_MB`). On Vercel, which refuses request bodies over
4.5 MB, every upload is capped at 4 MB. An upload over its limit gets a
`413` with `code: FILE_TOO_LARGE` and a message that says what to do.

## Rate limits

Sign-in, password reset, sign-up, the desk app's sign-in and the 2FA code
endpoint are all rate-limited (`src/middleware/rateLimit.js`). Failed
sign-ins and reset requests are counted per address **and** account (the
email, username or 2FA challenge typed in), with a looser ceiling per
address, so members sharing a gym's Wi-Fi do not lock each other out.
