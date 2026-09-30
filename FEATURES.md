# GymPilot feature map

Where each part of the product lives, what it stores, and the permission tab
that gates it. Every collection is per gym (see MULTI_TENANCY.md); every
setting is on the gym's `settings` document.

| Area | Backend | Admin UI | Member portal | Permission tab |
|---|---|---|---|---|
| Messaging (SMS / WhatsApp / push, campaigns, announcements, wording, automations) | `services/messaging.js`, `templateService.js`, `campaignService.js`, `automations.js`, `controller/messagingController.js` | `/admin/messaging`, Settings → Messaging | Profile → Notifications (channels, push per device) | `messaging` |
| Member profile (photo, emergency contact, health + PAR-Q, agreement, documents, tags, notes) | `controller/memberProfileController.js`, fields on `models/user.js`, `settings.membership.waiver` | Users → Profile | Profile tab | `users` |
| Adding a member at the desk | `controller/userController.js` `createMemberAccount` (the work behind `POST /admin/users`, exported so a one-screen "member + package + payment" flow can create the account as its first step and carry on with the returned `user`), `services/memberFields.js`. Beside names, `email?`, `phone`, `role` and the password choice it takes `gender` (text, 20), `dateOfBirth` (a date, not in the future), `address` (one line, stored as the primary entry of `addresses[]`) and `staffNotes` (staff-only); a bad detail refuses the whole create (400). The admin profile (`GET/PUT /admin/users/:id/profile`) reads and edits that one-line `address` | Users → New User; Users → Profile → Details | Addresses on the account page | `users` at manage |
| Member IDs (`GP-0001`) | `attendance/services/peopleDirectory.js` `assignMemberCode` — the next ID in the gym's one series when a member's account is created: the admin form, online sign-up (checkout signs people up that way), Google, a converted lead, the CSV import (a free ID from the old system is kept). Staff and administrators get none (they are `TR-`). Only `GP-` + digits count towards the series, so an imported `GP-A12` cannot restart it. `GET /get/allUsers` returns `memberCode` and `phone` and its `search` matches both. Older members: `node scripts/assignMemberCodes.js --gym <slug> \| --all [--apply]` (dry run by default, oldest first) | Users → Member ID and Phone columns | Profile | `users` |
| Sign in with email or username | `POST /user/login` reads `email` (or `login` / `username`) as either: an `@` means an email, anything else a username; both case-insensitive (`services/username.js` `loginFilter`); same errors, lockout and two-factor step as before. Staff choose a username with `PUT /admin/users/:id/username` / `PUT /staff/:id/username` `{ username }` — letters and digits, 3–30, at least one letter, unique across the platform; an administrator's only by an administrator; the phone app's directory row moves with it (`POST /admin/users/:id/username` still issues a generated one). The desk app's box says "Email or username" too — its `/api/desktop/login` must look the account up the same way | Sign-in page; Users (username → edit) and Staff (Username) | Sign-in page | `users` / `staff` at manage |
| Passwords set by staff (no email needed) | `services/adminPasswords.js`; `POST /admin/users/:id/password` and `POST /staff/:id/password` `{ password? }` — a typed password (8+ characters) is set; with none, a strong readable one is generated and returned once as `data.password` (`Cache-Control: no-store`). Every session ends (tokenVersion, front-desk sign-ins). Never your own (that is Change password), an administrator's only by an administrator, and never an account whose role holds any tab at a higher level than yours or a front-desk grant you lack. New accounts (`POST /admin/users`, `POST /staff`) take `credentials: 'email' \| 'show' \| 'set'` (+ `password`); when the welcome email fails the generated password comes back as `password` instead of being lost | Users and Staff → Set password (shown once, copy button); the create forms | — | `users` / `staff` at manage (audit-logged, password hidden) |
| Members without an email | `models/user.js` (email optional; unique only when present — partial index `email_1` on `{ email: { $type: 'string' } }`; a blank is stored as no field, never `''`), `services/emailService.js` (a send with no address answers `{ success: false, skipped: 'no email address' }` without contacting SMTP). `POST /admin/users` takes no `email` when a `phone` is given (400 without either); the password is then shown to the admin (`credentials` becomes `show`). Two-factor cannot be switched on without an email; the data export matches by email only when there is one. Existing gyms: `node scripts/migrateEmailIndex.js --gym <slug> \| --all [--apply]` (dry run by default; `scripts/lib/emailIndex.js`) — until then a gym holds one member without an email and refuses a second with a message saying so | Users → New User (email optional, phone then required) | Sign in with username | `users` |
| Member import (CSV) | `controller/userImportController.js` — `GET /admin/users/import/template`, `POST /admin/users/import` (multipart `file`, `dryRun=1` to preview). A row needs an email **or** a phone; names from `firstName`/`lastName` or one `name`/`full name` column (first word / the rest); also `address` (the primary address, one line), `active` (yes/no, active/inactive, 1/0; blank = active), `discount` (to the membership as `discountAmount`), `joining date`/`registration date` (the member's joined date — imports only). Rows without an email are de-duplicated by name + phone. The preview reports `created`, `withoutEmail`, `inactive`, `memberships`, the recognised `columns`, and each skipped / problem row by line | Users → Import CSV | — | `users` at manage |
| Leads | `models/leadModel.js`, `controller/leadController.js` (website enquiries become leads: the contact form, and the enquiry form's public `POST /api/leads/enquiry` — contact-form rate limit, honeypot `website`; a note on the person's open lead, matched by email or phone, else a new lead with source `website`; either way due for follow-up today) | `/admin/leads` | The website's enquiry form (`ContactSection`) | `leads` |
| Admin header: search and bell | `controller/adminSearchController.js` (`GET /admin/search?q=` — members, staff, leads, package orders, classes, trainers; every word must match; five per group), `controller/adminNotificationsController.js` (`GET /admin/notifications` — counts of what is waiting: failed card payments, bank transfers to confirm, new contact queries, registrations, lead follow-ups due, leave requests, memberships ending within 7 days) | `components/admin/AdminSearch.tsx`, `AdminNotifications.tsx` | — | any staff account; each group or count only from the tabs the account's live role can view |
| Direct uploads (files too big for the API) | `controller/uploadController.js` (`GET /api/uploads/capabilities`, `POST /api/uploads/blob` — a Vercel Blob client token for one path under the gym's own folder), `helper/blobUpload.js` `ownBlobUrl` | Homepage, Hero slides, Testimonials (`admin/_ops/directUpload.ts`); hero slides and testimonials then save the file's URL as `uploadedImageUrl` | — | `homepage` / `hero-slides` / `testimonials` at manage |
| Platform subscription (what the gym pays GymPilot) | `platform/routes/billingRoutes.js`, `platform/controllers/billingController.js` (plan usage meter), `platform/services/platformBilling.js` — see BILLING.md | Settings → Billing, trial / overdue banner | — | `settings` |
| Booking rules, timetable changes, rooms | `gymfolio/services/bookingRules.js`, `classSessions.js`, `models/classExceptionModel.js`, `controller/classExceptionController.js`; `settings.booking`, `settings.rooms` | Settings → General, `/admin/timetable-changes`, class room field | Timetable shows changes | `classes` |
| Personal training | `gymfolio/models/ptSessionModel.js`, `services/ptService.js`, `controller/ptController.js`; `settings.pt`; trainer `acceptsPt/ptRate/commissionPercent` | `/admin/pt` | Personal training tab | `pt` |
| Attendance corrections, fingerprints | `attendance/controller/attendanceCorrectionController.js` (`PATCH /api/attendance/records/:id` {checkInAt?, checkOutAt?, note} — fix times, note required, history kept in `edits[]`; `POST /api/attendance/records/:id/void` {reason} — a voided visit is left out of every total, pay and the member's history; `GET/PUT /api/attendance/settings` — `attendance.memberScanOut`, off for gyms where members only scan in), `attendance/controller/fingerprintAdminController.js` (`GET /api/attendance/fingerprints`, `DELETE /api/attendance/fingerprints/:personType/:personId[/:finger]`) | `/admin/attendance` (Edit times, Void, Desk settings), `/admin/fingerprints` | — | `attendance` (manage to change) |
| Staff leave, payslips, roster | `models/leaveRequestModel.js`, `models/payslipModel.js`, `services/payrollService.js`, `controller/hrController.js` | `/admin/staff/{roster,leave,payslips}` | My work tab (staff accounts) | `staff` |
| Shop / POS, stock | `models/productModel.js`, `saleModel.js`, `stockMovementModel.js`, `controller/posController.js` | `/admin/pos`, `/admin/inventory` | Receipts on profile | `pos` |
| Lockers | `models/lockerModel.js`, `controller/posController.js` | `/admin/lockers` | Locker on profile | `lockers` |
| Reports & exports | `controller/reportsController.js`, `services/csv.js` | `/admin/reports` | — | `reports` |
| Website: SEO, map, hours, language, embed, domains | `settings.seo/maps/openingHours/locale`, `platform/vercelDomains.js` | Settings → General → Website; platform panel domains | `/embed/timetable`, JSON-LD, language switcher | `settings` |
| PWA | — | — | `manifest.ts`, `public/sw.js` | — |
| Marketing site + platform panel (plans, gyms, demo requests, self-serve sign-up) | `platform/routes/platformRoutes.js`, `platform/controllers/{gymsController,plansController,demoRequestsController,signupController}.js`, `platform/services/signupProvisioning.js`, `platform/models/demoRequestModel.js` — sign-up in BILLING.md → *Self-serve sign-up* | `GymPilot_frontendAdmin` (`/` landing, `/checkout`, `/super-admin` panel) | — | super admin session (public routes under `/api/platform/public`) |

## Daily job

`GET/POST /api/jobs/reminders` (`Authorization: Bearer <CRON_SECRET>`; Vercel
Cron calls it daily at 03:00 UTC, `vercel.json`) first rolls platform
subscriptions and sends owners' billing notices (BILLING.md), then runs, per
active gym in its own database: close stale visits (check-ins left open
longer than `ATTENDANCE_OPEN_VISIT_HOURS` — staff visits sooner: rostered
shift end + `ATTENDANCE_STAFF_SHIFT_GRACE_HOURS`, or `ATTENDANCE_STAFF_OPEN_HOURS`
with no roster — are marked `autoClosed` and shown
as "No check-out" — no check-out time or duration is invented) → expire
lapsed orders → resume due freezes → membership expiry notices → class
reminders → PT reminders → auto no-shows (if on) → automations (absent /
win-back / birthday, if on). A gym whose subscription is inactive is skipped.

Pacing (`src/platform/jobs.js` `scheduleActiveGyms`): `DAILY_JOB_CONCURRENCY`
gyms side by side (default 3), and no new gym is started once
`DAILY_JOB_BUDGET_MS` (default 45000) has passed since the request arrived,
so the function answers before its time limit (DEPLOYMENT.md). Gyms go least
recently run first, from `platform_job_runs` (one row per job and gym:
`lastStartedAt`, `lastRunAt`, `lastOutcome`, `lastError`, `lastDurationMs`),
so a gym left over today is first tomorrow.

* `?dryRun=1` reports what it would do without sending or changing anything,
  and records no run.
* `?gym=<slug>` runs that one active gym only — a catch-up for a gym the
  budget left over or whose run failed. The platform-wide steps are skipped
  (`{ skipped: 'single gym run' }`); `404` when no active gym has the slug.
* The answer is `{ success, dryRun, subscriptions, notices, gyms: { <slug>:
  result }, schedule: { gym, concurrency, budget_ms, elapsed_ms, processed,
  failed, deferred, took_ms } }`. A gym the budget did not reach reads
  `{ skipped: 'time budget used; first in line next run' }` and its slug is in
  `schedule.deferred`.

## Tests

* `npm test` — the unit tests (`test/*.test.js`, `test/unit/**`); no
  database needed.
* `npm run test:integration` — `test/integration/**` against a real MongoDB:
  an in-memory server (`mongodb-memory-server`), one database per test gym,
  and email, notifications, Stripe and Vercel replaced by stand-ins
  (`test/integration/helpers/harness.js`). `.env` is never read, and every
  variable that could reach a real service is cleared. The MongoDB binary
  (8.2.6, roughly 80 MB) is downloaded once to `~/.cache/mongodb-binaries` —
  by `npm install`, or else by the first run. When the server cannot start
  every test is skipped with the reason; with
  `GYMPILOT_INTEGRATION_REQUIRED=1` (set it in CI) that is a failure instead.

## Adding a permission tab

1. `src/config/permissions.js` — add the key, label, group and path.
2. `src/services/roleService.js` — give the default roles a level (existing
   role documents keep `none` until an admin grants it).
3. Gate routes with `requirePermission('<key>')`.
4. Frontend: `AdminSidebar.tsx` item and `admin/layout.tsx` ROUTE_TABS.

## Adding a language

`GymPilot_frontend/src/i18n/dictionaries.ts` — add the code to `LANGUAGES`
and a dictionary; missing keys fall back to English. The gym picks its
language under Settings → General → Website; visitors can switch in the
header.
