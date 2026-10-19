# Security, sessions & members' data

## Sessions

Gym JWTs last 7 days on the website, 30 days with **Remember me** ticked and
30 days in the phone app. They carry `tid` (the gym that issued them) and
`tv` (the account's `tokenVersion`). `src/middleware/auth.js` checks both on
every request, re-reading the account at most every 30 seconds per process:

* a token from one gym is refused on another gym's site, and so is one that
  names no gym or no account at all;
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

A desk token (the Windows app's and the kiosk's) is not a JWT, so
`tokenVersion` never reached it. Everything above that ends an account's
sessions — a password change or reset, setting one, sign out everywhere,
staff **Sign out**, a Google takeover — revokes its desk tokens as well, and
the desk is at the sign-in window on its next request. A role change does not
need to: a desk re-reads its grant on every request.

Google sign-in finds an account by email. Anyone can sign up with any
address (it is confirmed afterwards, see *Email confirmation*), so the first
time Google — which has checked the address — links into a password account
that was not made through Google, that password is cleared and its sessions
end: a stranger who pre-registered the address is shut out, and the owner
can set a password with **Forgot password**, which also works for accounts
that have only ever used Google. The address then counts as confirmed.
Google sign-in gets the same two-factor step as a password.

Platform (super admin) tokens have their own secret and are refused by every
gym endpoint. They carry the admin's own `tokenVersion` (`tv`), checked on
every request (`src/platform/middleware/platformAuth.js`): signing out ends
that admin's sessions on the server, not only in the browser, a password
reset ends them all, and a password change ends every one but the one that
made it.

## Email confirmation — `src/services/emailVerification.js`

A sign-up takes any address, and a member may change theirs, so an address
on an account proves nothing until somebody has shown it is theirs
(`user.emailVerified`; only `false` means "not yet" — accounts from before
the flag count as confirmed, so nobody was cut off when it arrived).

What confirms an address: the link in the "confirm your email" message (7
days, single use, only its hash stored; the link opens a page with a button,
so a mail scanner opening it confirms nothing); a Google sign-in; a right
sign-in code or a password reset that was emailed to it; staff making or
importing the account, or vouching for a member at the desk
(`POST /admin/users/:id/verify-email`, users · manage). A self-service
sign-up, or a member changing their own address, starts unconfirmed and is
sent the link; `POST /user/verify-email/send` sends a fresh one. The old
address is told when it is replaced or removed.

What waits on it — and nothing else does; the account signs in, books and
pays as before, and everything filed under its own id is untouched:

* **a guest's purchases.** Somebody who paid before making an account is
  known by the address on the order. An account claims those orders — at the
  door, in the booking screen, in its data export — only once its address is
  confirmed. Before that, anyone could register a guest buyer's address and
  walk in on what they paid for;
* **what follows from having joined.** The same orders are what take the
  joining fee off, let a new term start when the current one ends, and
  refuse a second card subscription (BILLING.md → *Who has joined*): an
  unconfirmed address gets none of that, at checkout, by bank transfer or at
  the desk.

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

## Wrong passwords — `src/services/signInLock.js`

An account gets **10 password tries**; after ten wrong in a row its password
is not checked again for **15 minutes**. The count is kept on the account,
in the database, so it holds across servers and addresses alike (the request
limits under *Rate limits* are per address and in memory), and each try is
counted before the password is compared, so guesses sent all at once still
share the ten. It counts wherever the password is typed: the website, the
phone app, the front-desk app's sign-in, and the "current password" checks
below.

It cannot shut somebody out for good: it clears itself after the 15 minutes,
a right password clears the count, and a new password — a reset link,
"change password", staff setting one — opens the account at once. It pauses
only the password: Google sign-in, an emailed reset and sessions already
open are untouched. A refused sign-in reads the same whether the password
was wrong, the name unknown or the account paused, and always says that
ten wrong tries pause sign-in for 15 minutes.

## Type your current password

A session can be stolen (a shared computer, a copied token) without the
password being known. So two changes that decide who can get back into an
account need the current password typed again
(`passwordCheck.currentPasswordRefusal`): **changing or removing your own
email address** (`PUT /update/user` with `currentPassword`) and **switching
two-factor sign-in off** (`PUT /user/two-factor { enabled: false,
currentPassword }`; switching it on needs nothing more). Without it: `400`
with `code` `PASSWORD_REQUIRED`, `PASSWORD_INCORRECT` (wrong, or the
password is paused) or `PASSWORD_NOT_SET` (an account that only ever used
Google: **Forgot password** emails its address a link to set one, which is
the proof this check stands for). Wrong tries here use the same ten.

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
`/api/desktop/login`, which is gated by `allowAttendanceApp` as well and
asks for the same code: an account that needs it gets `200 { success: false,
requires2fa: true, challenge_id, method: "email", message }` and no token
(`503` when the code cannot be emailed, `409` with no address to send it
to), and `POST /api/desktop/login/2fa { challenge_id, code, client_app,
device_label }` answers exactly what a plain desk sign-in answers. A wrong
code is `401 TWO_FACTOR_INVALID`; a used, stale or tried-out one is `401
TWO_FACTOR_EXPIRED` (sign in again). A desk linked with a code from the
admin panel signs in as the account that made the code, which had to sign in
to the website to make it.

## Admin audit log

Every write that passes a permission gate (`src/middleware/requirePermission.js`)
is recorded after the response — who, method, path, area, status, and a
summary of the body with credential-like fields hidden. **System → Audit log**
(`GET /admin/audit-log`), permission tab `audit`.

## Biometric consent

Fingerprint and face templates are biometric data. Neither is an image:
a fingerprint template is the reader's fused enrolment template, and a face
is a handful of SFace feature vectors (128 numbers each) made on the desk PC
— the server never receives a picture. Both are matched on the desk PC, so
they leave the server decrypted in one place each (`/api/desktop/templates`,
`/api/desktop/face-templates`), to a signed-in Windows desk, with every
download in the attendance audit trail; the web kiosk is refused both.

**Fingerprints.** Nothing is stored until the person has agreed:

* the member ticks **I agree** under Security & privacy on their account
  page (`PUT /user/consents { biometric: true }`);
* or staff record a signed form with **Consent** on the Users screen
  (`PUT /admin/users/:id/consent`);
* or the desk ticks the consent box in the attendance app's enrol form
  (sent as `consent: true` to `/api/desktop/enroll`).

Without any of those, enrolment answers `409 CONSENT_REQUIRED`.

**Faces.** Consent is asked at the desk every time a face is registered: the
operator ticks the box with the person in front of them (`consent: true` to
`/api/desktop/face-enroll`, else `400 CONSENT_REQUIRED`), and the moment and
the operator are kept on the face (`consentAt`, `consentBy`). Fingerprint
consent does not stand in for it.

**Removal and retention.** A template is kept until one of these deletes it
(deleted, not hidden):

* the person deletes their own face (`DELETE /api/attendance/me/face`;
  `GET /api/attendance/me/face` says whether one is on file);
* the person withdraws biometric consent, or staff record it withdrawn —
  every fingerprint and the face go;
* staff remove one: the desk (`/api/desktop/face-remove`) or the admin panel
  (`DELETE /api/attendance/fingerprints/…`, `DELETE /api/attendance/faces/:personType/:personId`);
* the person's account or trainer record is deleted.

Someone switched off (an inactive member, a trainer no longer on the staff)
keeps what is on file, but no desk downloads it or matches them, until they
are switched back on or it is removed.

Templates are encrypted with keys derived per gym from
`FINGERPRINT_ENCRYPTION_KEY`, salted with the gym id — `gympilot.fingerprint.v1`
for fingers (the pre-platform gym keeps its original key) and
`gympilot.face.v1` for faces, so one cannot open the other.

## A copy of their data

`GET /user/export` — the member's account, memberships, bookings, visits,
fingerprint and face metadata (not the templates) and enquiries as a JSON
download;
**Download my data** on the account page.

## Newsletter unsubscribe

Every unsubscribe link in a newsletter email carries a token: an HMAC of the
address and the gym, keyed from `JWT_SECRET` under its own purpose label
(`src/services/unsubscribeLinks.js`). `POST /api/newsletter/unsubscribe`
refuses an address without its token, so nobody can take somebody else off
the list, and the `/unsubscribe` page waits for a click rather than acting on
page load, so a mail scanner opening the link changes nothing. Rotating
`JWT_SECRET` invalidates links in emails already sent.

## Uploads

**The store is public by URL.** Whoever has a file's address can open it —
Vercel Blob as installed has no private files, and files kept on local disk
are served from `/uploads` the same way — and that goes for a member's ID
scan or medical letter as much as for a class photo. So the address is the
secret: every stored name carries 128 random bits from the system's random
source (`helper/blobUpload.js`, `helper/upload.js`), where the older names
(a timestamp and a small random number) could be worked out. Treat a
document's link as the document. Files stored before this keep their old
names.

**Files go with the account.** Deleting an account removes what was uploaded
for it — its photo and its documents — along with its fingerprints, face, push
registrations, desk sign-ins and phone-app username
(`userController.releaseAccount`); removing one document or replacing a
photo deletes that file. Only files under the gym's own folder are ever
deleted.

Images are JPEG, PNG, WebP or GIF — SVG is refused, since it can carry
script — and a stored file is named for the type that was checked, not the
name it arrived with. Limits: images 5 MB (`UPLOAD_MAX_FILE_SIZE_MB`), hero
images 20 MB, member documents 10 MB, CSV imports 5 MB, videos 100 MB
(`UPLOAD_MAX_VIDEO_SIZE_MB`). On Vercel, which refuses request bodies over
4.5 MB, every upload is capped at 4 MB. An upload over its limit gets a
`413` with `code: FILE_TOO_LARGE` and a message that says what to do.

## Online payments and saved cards

**The money goes to the gym.** Each gym connects its own Stripe or Safepay
account; GymsPilotPro never holds a member's money, and there is no platform
key a gym could fall back on. Safepay's secret key and webhook secret are
sealed at rest like every other Settings secret (`services/secretBox.js`),
shown to the admin only as a masked preview, kept when the preview is sent
back, and never in the public settings. Outside production a test may point
the connector at a stand-in Safepay (`SAFEPAY_API_BASE_URL`); in production
the keys only ever go to Safepay's own hosts.

**Amounts come from the server.** A checkout's amount is what the order owes
— the package price, joining fee and coupon worked out as for Stripe, or the
balance due — never a figure the browser sends, and a payment Safepay reports
for less than was asked is not applied. The member is sent back to the gym's
primary domain from its platform record, never to an address taken from the
request.

**Webhooks are believed only when signed.** Safepay's events arrive at
`/api/payments/safepay/webhook/<gym>` and are checked against the
`X-SFPY-SIGNATURE` header with THAT gym's webhook secret, over the exact bytes
received; anything unsigned, signed by someone else or changed on the way is
refused (400). The same payment delivered twice is applied once.

**Saved cards are tokens, kept only with consent.** Card numbers never reach
GymsPilotPro: the member types them on Safepay's page and passes 3-D Secure
there. A card is kept only when the member ticked "save my card and pay
automatically" and agreed to the consent sentence, at a gym that has switched
automatic payments on, for a signed-in account. What is kept on the member
(`billing.savedMethods`, never in an ordinary read of the account) is
Safepay's token for the card — sealed — with the brand, last four digits,
expiry, the consent sentence and when it was given. Removing it stops
automatic payment at once and deletes it from Safepay's wallet too.

## Rate limits

Sign-in, password reset, sign-up, the desk app's sign-in and the 2FA code
endpoint are all rate-limited (`src/middleware/rateLimit.js`). Failed
sign-ins and reset requests are counted per address **and** account (the
email, username or 2FA challenge typed in, read from the same field, in
the same order, as the handler behind the route reads it -- so a decoy in
another field buys no fresh count), with a looser ceiling per address, so
members sharing a gym's Wi-Fi do not lock each other out. The desk app
counts its failures per account, whether it was named by email or by
username, and its sign-in also uses the account's ten password tries (see
*Wrong passwords*). A sign-in name of spaces alone is refused (400), never looked up.
