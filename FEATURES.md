# GymPilot feature map

Where each part of the product lives, what it stores, and the permission tab
that gates it. Every collection is per gym (see MULTI_TENANCY.md); every
setting is on the gym's `settings` document.

| Area | Backend | Admin UI | Member portal | Permission tab |
|---|---|---|---|---|
| Messaging (SMS / WhatsApp / push, campaigns, announcements, wording, automations) | `services/messaging.js`, `templateService.js`, `campaignService.js`, `automations.js`, `controller/messagingController.js` | `/admin/messaging`, Settings → Messaging | Profile → Notifications (channels, push per device) | `messaging` |
| Member profile (photo, emergency contact, health + PAR-Q, agreement, documents, tags, notes) | `controller/memberProfileController.js`, fields on `models/user.js`, `settings.membership.waiver` | Users → Profile | Profile tab | `users` |
| Leads | `models/leadModel.js`, `controller/leadController.js` (website enquiries become leads: the contact form, and the enquiry form's public `POST /api/leads/enquiry` — contact-form rate limit, honeypot `website`; a note on the person's open lead, matched by email or phone, else a new lead with source `website`; either way due for follow-up today) | `/admin/leads` | The website's enquiry form (`ContactSection`) | `leads` |
| Admin header: search and bell | `controller/adminSearchController.js` (`GET /admin/search?q=` — members, staff, leads, package orders, classes, trainers; every word must match; five per group), `controller/adminNotificationsController.js` (`GET /admin/notifications` — counts of what is waiting: failed card payments, bank transfers to confirm, new contact queries, registrations, lead follow-ups due, leave requests, memberships ending within 7 days) | `components/admin/AdminSearch.tsx`, `AdminNotifications.tsx` | — | any staff account; each group or count only from the tabs the account's live role can view |
| Direct uploads (files too big for the API) | `controller/uploadController.js` (`GET /api/uploads/capabilities`, `POST /api/uploads/blob` — a Vercel Blob client token for one path under the gym's own folder), `helper/blobUpload.js` `ownBlobUrl` | Homepage, Hero slides, Testimonials (`admin/_ops/directUpload.ts`); hero slides and testimonials then save the file's URL as `uploadedImageUrl` | — | `homepage` / `hero-slides` / `testimonials` at manage |
| Platform subscription (what the gym pays GymPilot) | `platform/routes/billingRoutes.js`, `platform/controllers/billingController.js` (plan usage meter), `platform/services/platformBilling.js` — see BILLING.md | Settings → Billing, trial / overdue banner | — | `settings` |
| Booking rules, timetable changes, rooms | `gymfolio/services/bookingRules.js`, `classSessions.js`, `models/classExceptionModel.js`, `controller/classExceptionController.js`; `settings.booking`, `settings.rooms` | Settings → General, `/admin/timetable-changes`, class room field | Timetable shows changes | `classes` |
| Personal training | `gymfolio/models/ptSessionModel.js`, `services/ptService.js`, `controller/ptController.js`; `settings.pt`; trainer `acceptsPt/ptRate/commissionPercent` | `/admin/pt` | Personal training tab | `pt` |
| Attendance corrections, fingerprints, live view | `attendance/controller/adminAttendanceController.js` `GET /api/attendance/live` (?personType, ?q — today's visits newest first: arrival number, member ID, name, phone, gender, package, next expiry, time in/out and a Paid / Unpaid / Expiring / Balance due / Frozen status from `services/liveBoard.js`, plus the day's counts; paid = walked in on an active, frozen or still-running cancelled membership, each member counted once by their latest visit; the desk board's `/api/desktop/recent` rows carry `end_date_label`), `attendance/controller/attendanceCorrectionController.js` (`PATCH /api/attendance/records/:id` {checkInAt?, checkOutAt?, note} — fix times, note required, history kept in `edits[]`; `POST /api/attendance/records/:id/void` {reason} — a voided visit is left out of every total, pay and the member's history; `GET/PUT /api/attendance/settings` — `attendance.memberScanOut`, off for gyms where members only scan in; `attendance.voice` { enabled, expiredMessage, expiringMessage, balanceDueMessage } — what the desk and kiosk say after the alert sound, a blank message being the default; a member punch carries `detail.alert` { level: ok / warning / problem, speech } from `punchService.memberAlert`; money still owed on the member's paid order (`payment.balanceDue` > 0) never blocks entry — the punch carries the amber warning "Balance due £25" (`detail.balance_due`, `balance_due_label`), the warning sound and the balance message, and the visit keeps `membership.balanceDue` / `currency` so the check-out repeats it), `attendance/controller/fingerprintAdminController.js` (`GET /api/attendance/fingerprints`, `DELETE /api/attendance/fingerprints/:personType/:personId[/:finger]`) | `/admin/attendance` (Today · live — refreshes every 15 s while the tab is visible; Edit times, Void, Desk settings), `/admin/fingerprints` | — | `attendance` (manage to change) |
| Staff leave, payslips, roster | `models/leaveRequestModel.js`, `models/payslipModel.js`, `services/payrollService.js`, `controller/hrController.js` | `/admin/staff/{roster,leave,payslips}` | My work tab (staff accounts) | `staff` |
| Shop / POS, stock | `models/productModel.js`, `saleModel.js`, `stockMovementModel.js`, `controller/posController.js` | `/admin/pos`, `/admin/inventory` | Receipts on profile | `pos` |
| Till sales (basket and payment) | `controller/posController.js` (`GET /admin/pos/products` also answers `tax_rate` from Settings so the basket shows line totals, discount, the included tax and the total before payment, worked out as `POST /admin/pos/sales` works them out: tax-inclusive prices, discount off the whole basket, tax on the taxable lines' share; `paymentMethod` one of cash, card, bank_transfer, jazzcash, easypaisa, wallet (another mobile wallet), online, account, other — anything else is 400, never read as cash; `tendered` on a cash sale records the cash received and the change, refused when less than the total, ignored for other methods) | `/admin/pos` basket | — | `pos` (manage to sell) |
| Till receipts (thermal) | `controller/posController.js` (`GET /admin/pos/receipt-settings` — `settings.receipt` {paperWidth `80mm` or `58mm`, showLogo, footerText up to 300 characters; an empty footer prints `invoice.footerNote`} with the gym's name, logo, address, phone, email and `invoice` tax label and number; `PUT` {paperWidth?, showLogo?, footerText?} changes only what is sent and refuses anything else with 400) | `/admin/pos` (Receipt settings; Print sends the receipt alone to the printer, one page as long as the receipt and as wide as the roll — `components/receipts/`) | — | `pos` (read at view, change at manage) |
| Till sales history, export, profit | `controller/posController.js` (`GET /admin/pos/sales?from=&to=` — local calendar days, this month by default; the list shows the latest 500 (`truncated` when there are more), the summary covers every paid sale in the range; `GET /admin/pos/sales/export?from=&to=` — every sale in the range as CSV (`services/csv.js`), refunded ones marked. For `pos` at manage only: each line's `unit_cost`, `cost` and `margin` (line total less cost), each sale's `cost` and `profit` (total, less the tax included in it, less cost — so the basket discount comes off it), the range's `cost` and `gross_profit` per currency, and Cost and Profit columns in the CSV; cost is the product's cost when it was sold, kept on the line) | `/admin/pos` (Sales: dates, presets, Export CSV; cost and profit for manage) | — | `pos` (view; cost and profit at manage) |
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
