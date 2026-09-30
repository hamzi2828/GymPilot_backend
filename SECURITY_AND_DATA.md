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

## Who may act on whose account

Below an administrator, nobody creates an account in, moves one into or out
of, deactivates, deletes or sets the password of one whose role holds any tab
at a higher level than their own, or switches on a front-desk grant they lack
(`src/services/roleGuards.js`, `src/services/adminPasswords.js`). A new
account's emailed password counts: it goes to whatever address was typed.
Changing or regenerating somebody's username holds the same line (your own
is yours to change). Only an administrator touches an administrator.

Signing in with a name nobody has costs the same bcrypt work as a real
account (`src/services/passwordCheck.js`), so the time an answer takes does
not say which usernames or addresses exist.

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

**Download.** Settings → **Data & backup** → *Download full backup*
(`POST /api/backups/download`). Administrators only — `settings` at manage
*and* the administrator role (`src/routes/backupRoutes.js`) — and every call
is in the audit log (a POST, so the permission gate records it; a download
that breaks part-way is recorded by the controller). The archive is made on
the spot and streamed to the browser as it is read from the database: Vercel
refuses a function response over 4.5 MB unless it is streamed, and streaming
is on for every Node.js function, so neither that cap nor the function's
memory limits how big a gym can be.

**The archive** (`src/services/backupService.js`) is a `.tar.gz` any archive
tool opens:

* `backup.json` — format, version, the gym (id, slug, name), when, and why
  (`download`, `daily`, `pre-restore`, `cli`);
* per collection, `collections/<name>.json` (its options and index
  definitions), then `collections/<name>.jsonl` — one document per line in
  canonical Extended JSON, in parts of about 8 MB (`<name>.2.jsonl`, …), each
  a file `mongoimport` takes as it is;
* `manifest.json` last, with each collection's document count. A file
  without it did not finish, and is refused.

Every collection of the gym's database is in it except MongoDB's
(`system.*`) and the platform's (`gyms`, `super_admins`, `platform_*`): the
first gym shares the platform's database, and its backup must carry neither
the other gyms' records nor the super admins. Collections are read one after
another while the gym runs, so it is not a point-in-time snapshot across
collections (as `mongodump` without `--oplog`).

**Secrets inside a backup stay sealed.** Documents are copied exactly as
stored, so the Settings secrets (Stripe, SMTP, SMS/WhatsApp tokens, push
key) and fingerprint templates are in the archive as ciphertext under this
deployment's `SETTINGS_ENCRYPTION_KEY` / `FINGERPRINT_ENCRYPTION_KEY`, salted
with the gym's id; a Settings secret still in plaintext from before sealing
existed is sealed on its way into the archive. A downloaded backup therefore
holds no working key, and those values only open again when it is restored
into the same gym on a deployment with the same keys (otherwise they read as
empty and are typed in again). Everything else — members' details, health
answers, password hashes — is in the file as it is in the database: treat a
downloaded backup as the members' personal data it is.

**Stored backups** — made every night for every active gym (FEATURES.md →
*Daily backup*), or with *Back up now* — are that same archive, encrypted on
the server as it is written (`src/services/backupCrypto.js`) and stored in
the Vercel Blob store as it is encrypted (`backupStorage.js`, under
`<slug>/backups/<kind>/`), so no step holds the whole file. They are listed
in the platform database (`platform_backups`), not the gym's, so a restore
can never roll back the list of backups. Settings → Data & backup shows date,
kind, size and record count; *Download* has the server decrypt one and
stream it back as the plain `.tar.gz`. The newest `BACKUP_KEEP_DAILY`
(default 7) of each kind are kept per gym.

Why encrypted: every file in the Blob store is public — the installed
`@vercel/blob` (0.23) has no private access — so a stored backup is
unreadable without a key the store never sees:

* **The key is `BACKUP_ENCRYPTION_KEY`, with no fallback.** Borrowing
  `JWT_SECRET` or `SETTINGS_ENCRYPTION_KEY` would tie every stored backup to a
  secret that may one day be rotated for other reasons. Without it nothing is
  stored and the reason is shown (the download needs no key and keeps
  working). **Never change it once set**: backups made with the old value can
  no longer be opened — each file carries a short key id, so that is reported
  as "made before BACKUP_ENCRYPTION_KEY was changed", not as damage.
* Per gym, scrypt of that key with a salt carrying the gym's id — one gym's
  file cannot be opened as another's; per file, HKDF of that with 32 random
  bytes kept in the file's header, so every file has its own AES-256-GCM key.
* The file is sealed in 1 MiB chunks, each with its own tag, a counter nonce
  and a last-chunk flag, and the header as additional data. Nothing is
  released before it is authenticated, a changed byte anywhere fails, and so
  does a file cut short even at a chunk boundary.

**Restore** (Settings → Data & backup; `src/services/backupRestore.js`),
from a stored backup or from a file the owner uploads — a `.tar.gz` this gym
downloaded. Administrators only, every step in the audit log:

1. *Preview* (`POST /api/backups/restore/preview { backupId }`): the whole
   file is read — decrypted, every chunk authenticated, every count checked
   against the manifest — and described: the gym it is of, when it was taken,
   each collection and its record count. Nothing changes.
2. The owner types the gym's slug (`POST /api/backups/restore { backupId,
   confirm }`); anything else is `400 CONFIRMATION_MISMATCH`.
3. A backup of another gym is refused (`409 BACKUP_OTHER_GYM`): its header
   names the gym by id. An uploaded file is also encrypted with this gym's
   key, and another gym's stored backups cannot be named at all.
4. A backup of the gym as it is now is stored (kind `pre-restore`). If it
   cannot be made, nothing is touched. The tidy-up of old backups after it
   spares the file being restored, which is only read in the next step.
5. Every collection in the file is loaded into a staging collection
   (`__restoring__<name>`) with its options and indexes, beside the live one.
   Until the whole file has been read and checked the live data is untouched;
   any failure drops the staging collections and leaves the gym as it was.
6. Each staging collection replaces its live one (`renameCollection` with
   `dropTarget`), and live collections the backup does not have are dropped.
7. Every session ends, everyone's: the accounts came back with the
   sign-ins the backup knew of, some of them ended on purpose since (a
   password reset after a stolen token). Every account's `tokenVersion`
   becomes one above any a token could carry (above the highest before and
   after, and above the time in seconds, for accounts deleted since the
   backup); pending reset links and sign-in codes are cleared; every desk
   sign-in is revoked; the session cache is dropped. The answer says
   everyone, the admin included, must sign in again (`signedOut: true`).

Never touched: the platform's and MongoDB's collections, and the admin audit
log (`gym_admin_audit_logs`), which keeps its history — a restore must not be
a way to erase the record of what was done, the restore included. One restore
per gym at a time (`platform_job_runs`, job `restore`; a lock older than 15
minutes is taken over). The whole restore runs inside one request, so the
function's time limit bounds the size of gym it can restore (DEPLOYMENT.md);
this server's caches are reset afterwards, other instances' expire within a
minute.

Uploading: Vercel refuses request bodies over 4.5 MB (streaming does not lift
that), so the file goes from the browser straight to the Blob store with a
client token good for one path (`POST /api/backups/uploads`, the same
client-upload mechanism as the admin pages' big images). The store is public
and the file is the membership in plain text, so the browser encrypts it
first, in the stored backups' own format, with a key the server derives for
this gym and that one file; `POST /api/backups/uploads/:id/complete` accepts
only the exact path granted. Uploads are never listed as backups and are
removed once restored, or after a day. Largest upload: 500 MB.

**By hand:**

    node scripts/backupGym.js --gym <slug> [--out backups]
    node scripts/backupGym.js --all

The same archive, as `backups/<slug>/<slug>-backup-<timestamp>.tar.gz`;
`--all` also writes `backups/_platform/…` with the platform's own collections,
which no gym's archive carries. To restore one collection by hand, extract
the archive and `mongoimport --file collections/<name>.jsonl`. Copy the files
off the server.

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
email, username or 2FA challenge typed in, read from the same field, in
the same order, as the handler behind the route reads it -- so a decoy in
another field buys no fresh count), with a looser ceiling per address, so
members sharing a gym's Wi-Fi do not lock each other out. The desk app
counts its failures per account, whether it was named by email or by
username. A sign-in name of spaces alone is refused (400), never looked up.
