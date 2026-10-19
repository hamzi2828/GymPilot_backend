# GymsPilotPro feature map

Where each part of the product lives, what it stores, and the permission tab
that gates it. Every collection is per gym (see MULTI_TENANCY.md); every
setting is on the gym's `settings` document.

| Area | Backend | Admin UI | Member portal | Permission tab |
|---|---|---|---|---|
| Messaging (SMS / WhatsApp / push, campaigns, announcements, wording, automations) | `services/messaging.js`, `templateService.js`, `campaignService.js`, `automations.js`, `controller/messagingController.js` | `/admin/messaging`, Settings → Messaging | Profile → Notifications (channels, push per device) | `messaging` |
| Member profile (photo, emergency contact, health + PAR-Q, agreement, documents, tags, notes) | `controller/memberProfileController.js`, fields on `models/user.js`, `settings.membership.waiver` | Users → Profile | Profile tab | `users` |
| Adding a member at the desk | `controller/userController.js` `createMemberAccount` (the work behind `POST /admin/users`, exported so a one-screen "member + package + payment" flow can create the account as its first step and carry on with the returned `user`), `services/memberFields.js`. Beside names, `email?`, `phone`, `role` and the password choice it takes `gender` (text, 20), `dateOfBirth` (a date, not in the future), `address` (one line, stored as the primary entry of `addresses[]`) and `staffNotes` (staff-only); a bad detail refuses the whole create (400). The admin profile (`GET/PUT /admin/users/:id/profile`) reads and edits that one-line `address`. **One screen, all or nothing:** `POST /api/admin/members/register` (`controller/memberRegistrationController.js`) takes those member fields plus an optional `membership` block — the `/package-orders/assign` body without `userId` (BILLING.md → *At the desk*), plus `joiningFeeOverride` (an admission fee other than the package's, charged and counted as admission; not with `waiveJoiningFee`) — and answers `201 { success, message, member, order (null without a membership), credentials, emailed, emailError, password? }`. Always a plain member (`role` other than `user` is `400 INVALID_ROLE`); the registration date is the moment it is made, and a body naming one (`createdAt`, `joinedAt`, `registeredAt`, `registrationDate`, `joiningDate`) is `400 REGISTRATION_DATE_LOCKED`. Selling needs `package-orders` at manage as well (checked inside, 403). What the sale would refuse without the account — terms, package, price, method, trainer, coupon, money taken above the total — is refused before the account is made (nothing created, nothing emailed); a sale that still fails deletes the new account again with its orders and directory row (`userController.releaseAccount`) and answers the order's own error. An optional `requestId` (top level, or `membership.requestId`) makes a retry after a lost reply answer with the member and order already made (`repeated: true`, no `password`) instead of adding and charging a second one (BILLING.md → *Sent twice*) | Users → New User; Users → Add member (member, membership and payment, receipt); Users (Members view: package, next expiry, paid, discount and balance due from `POST /package-orders/summary`, one call per page of 50; Active / Inactive and membership filters); Users → Profile → Details | Addresses on the account page | `users` at manage (+ `package-orders` at manage to sell) |
| Member IDs (`GP-0001`) | `attendance/services/peopleDirectory.js` `assignMemberCode` — the next ID in the gym's one series when a member's account is created: the admin form, online sign-up (checkout signs people up that way), Google, a converted lead, the CSV import (a free ID from the old system is kept). Staff and administrators get none (they are `TR-`). Only `GP-` + digits count towards the series, so an imported `GP-A12` cannot restart it. `GET /get/allUsers` returns `memberCode` and `phone` and its `search` matches both. Older members: `node scripts/assignMemberCodes.js --gym <slug> \| --all [--apply]` (dry run by default, oldest first) | Users → Member ID and Phone columns | Profile | `users` |
| Sign in with email or username | `POST /user/login` reads `email` (or `login` / `username`) as either: an `@` means an email, anything else a username; both case-insensitive (`services/username.js` `loginFilter`); same errors, lockout and two-factor step as before. Staff choose a username with `PUT /admin/users/:id/username` / `PUT /staff/:id/username` `{ username }` — letters and digits, 3–30, at least one letter, unique across the platform; an administrator's only by an administrator, and nobody's whose role reaches further than yours or who holds a front-desk grant you lack (your own is yours to change); the phone app's directory row moves with it (`POST /admin/users/:id/username` still issues a generated one, under the same rule). An unknown name costs the same bcrypt work as a real one (`services/passwordCheck.js`), on the website, the desk, the phone app and the platform panel. The desk app's box says "Email or username" too — its `/api/desktop/login` must look the account up the same way | Sign-in page; Users (username → edit) and Staff (Username) | Sign-in page | `users` / `staff` at manage |
| Passwords set by staff (no email needed) | `services/adminPasswords.js`; `POST /admin/users/:id/password` and `POST /staff/:id/password` `{ password? }` — a typed password (8+ characters) is set; with none, a strong readable one is generated and returned once as `data.password` (`Cache-Control: no-store`). Every session ends (tokenVersion, front-desk sign-ins). Never your own (that is Change password), an administrator's only by an administrator, and never an account whose role holds any tab at a higher level than yours or a front-desk grant you lack. The same line holds on creating an account (however its first password travels: an emailed one goes to whatever address was typed), moving one into or out of a role, deactivating and deleting it, and switching on a front-desk grant (`services/roleGuards.js`), so a role change is no way round it. New accounts (`POST /admin/users`, `POST /staff`) take `credentials: 'email' \| 'show' \| 'set'` (+ `password`); when the welcome email fails the generated password comes back as `password` instead of being lost | Users and Staff → Set password (shown once, copy button); the create forms | — | `users` / `staff` at manage (audit-logged, password hidden) |
| Members without an email | `models/user.js` (email optional; unique only when present — partial index `email_1` on `{ email: { $type: 'string' } }`; a blank is stored as no field, never `''`), `services/emailService.js` (a send with no address answers `{ success: false, skipped: 'no email address' }` without contacting SMTP). `POST /admin/users` takes no `email` when a `phone` is given (400 without either); the password is then shown to the admin (`credentials` becomes `show`). Two-factor cannot be switched on without an email; the data export matches by email only when there is one. Existing gyms: `node scripts/migrateEmailIndex.js --gym <slug> \| --all [--apply]` (dry run by default; `scripts/lib/emailIndex.js`) — until then a gym holds one member without an email and refuses a second with a message saying so | Users → New User (email optional, phone then required) | Sign in with username | `users` |
| Member import (CSV) | `controller/userImportController.js` — `GET /admin/users/import/template`, `POST /admin/users/import` (multipart `file`, `dryRun=1` to preview). A row needs an email **or** a phone; names from `firstName`/`lastName` or one `name`/`full name` column (first word / the rest); also `address` (the primary address, one line), `active` (yes/no, active/inactive, 1/0; blank = active), `discount` (to the membership as `discountAmount`), `joining date`/`registration date` (the member's joined date — imports only). Rows without an email are de-duplicated by name + phone. The preview reports `created`, `withoutEmail`, `inactive`, `memberships`, the recognised `columns`, and each skipped / problem row by line. A membership imported as paid is marked `imported` on its order: the money was taken in the old system, so it is left out of every takings figure and gets no invoice number (BILLING.md → *Imported memberships are not takings*). A run stops starting rows after `IMPORT_BUDGET_MS` (default 40 s) and says how many are left; the same file uploaded again carries on | Users → Import CSV | — | `users` at manage |
| Leads | `models/leadModel.js`, `controller/leadController.js` (website enquiries become leads: the contact form, and the enquiry form's public `POST /api/leads/enquiry` — contact-form rate limit, honeypot `website`; a note on the person's open lead, matched by email or phone, else a new lead with source `website`; either way due for follow-up today) | `/admin/leads` | The website's enquiry form (`ContactSection`) | `leads` |
| Admin header: search and bell | `controller/adminSearchController.js` (`GET /admin/search?q=` — members, staff, leads, package orders, classes, trainers; every word must match; five per group), `controller/adminNotificationsController.js` (`GET /admin/notifications` — counts of what is waiting: failed card payments, bank transfers to confirm, new contact queries, registrations, lead follow-ups due, leave requests, memberships ending within 7 days; equipment services due within 7 days or overdue and warranties ending within 30 days, by the asset register's own rule in `accounts/services/assetReminders.js` — the bell is the only way admins are told, nothing is emailed or pushed) | `components/admin/AdminSearch.tsx`, `AdminNotifications.tsx` | — | any staff account; each group or count only from the tabs the account's live role can view |
| Direct uploads (files too big for the API) | `controller/uploadController.js` (`GET /api/uploads/capabilities`, `POST /api/uploads/blob` — a Vercel Blob client token for one path under the gym's own folder), `helper/blobUpload.js` `ownBlobUrl` | Homepage, Hero slides, Testimonials (`admin/_ops/directUpload.ts`); hero slides and testimonials then save the file's URL as `uploadedImageUrl` | — | `homepage` / `hero-slides` / `testimonials` at manage |
| Memberships sold (package orders: the desk, fees, payment methods, part payments and dues, expiry lists) | `gymfolio/services/membershipService.js`, `orderMoney.js` (admission / trainer fee / membership split), `membershipLists.js`, `services/paymentMethods.js`, `controller/membershipController.js`, `membershipListsController.js`, `gymfolioPaymentController.js`; `payment.joiningFee` / `trainerFee` / `amountPaid` / `balanceDue` / `installments` on the order, fed to `ledger.membershipPaymentStages`; `POST /package-orders/:id/payments`, `PATCH /package-orders/:id/terms` (`termsHistory`), the desk lists `GET /package-orders/dues`, `/expiring`, `/expired` and `POST /package-orders/summary`; the fee desk's reads `services/feeDesk.js`, `controller/feeDeskController.js` (`GET /package-orders/desk/members?q=` — search by name, phone digits or member ID; `GET /package-orders/desk/members/:userId` — the membership a renewal follows, the package's price today, dues); `scripts/backfillOrderFees.js` — see BILLING.md | `/admin/package-orders`, `/admin/packages`, `/admin/fee-collection` (Collect fees: find a member, collect & renew, collect dues, new membership, thermal receipt), `/admin/fee-expiry` (Expiring · Expired / unpaid · Dues; CSV and print) | Account → history | `package-orders` (`packages` for the catalogue; taking money at manage) |
| Online payments (one gateway per gym: Stripe, Safepay, generic bank transfer; checkout, webhook, saved cards) | `services/payments` (the gateway registry: `providers/{stripe,safepay,generic}.js`), `services/safepay` (Safepay's API, checkout, saved-card charges, webhook, saved cards), `controller/paymentWebhookController.js`, `routes/paymentWebhookRoutes.js`; `settings.onlinePayments` / `safepay` / `billing`; order `payment.provider` / `payment.safepay`; member `billing.savedMethods` — see *Online payments* below | Settings → Payments | Checkout, `/checkout/success`, account (pay a balance or a due renewal online) | `settings` |
| Platform subscription (what the gym pays GymsPilotPro) | `platform/routes/billingRoutes.js`, `platform/controllers/billingController.js` (plan usage meter), `platform/services/platformBilling.js` — see BILLING.md | Settings → Billing, trial / overdue banner | — | `settings` |
| Booking rules, timetable changes, rooms | `gymfolio/services/bookingRules.js`, `classSessions.js`, `models/classExceptionModel.js`, `controller/classExceptionController.js`; `settings.booking`, `settings.rooms` | Settings → General, `/admin/timetable-changes`, class room field | Timetable shows changes | `classes` |
| Personal training | `gymfolio/models/ptSessionModel.js`, `services/ptService.js`, `controller/ptController.js`; `settings.pt`; trainer `acceptsPt/ptRate` and commission `commissionType` ('percent' of the session \| fixed 'amount' per session) + `commissionValue` (null = the gym's default percent; `commissionPercent` kept in step for a percent), stored on each completed session as `commission {basis, percent, amount}`; `GET /pt/summary` adds each trainer's `commission_terms` and `paid_by` ('payslip' when linked to an active staff account, else 'direct' — payable by hand) | `/admin/pt` | Personal training tab | `pt` |
| Trainer pay | `gymfolio/models/trainerModel.js` `salary` (null = not set, 0 = commission only) + `salaryCycle`, both `select: false` — the Accounts wage bill costs a trainer with no staff account at it, while a linked trainer is paid by the staff account's pay rate (payslips); `trainerController` (public reads leave out every pay term; the admin list returns them and takes `?id=`) | `/admin/trainers` | — | `trainers` |
| Attendance corrections, fingerprints and faces, live view | `attendance/controller/adminAttendanceController.js` `GET /api/attendance/live` (?personType, ?q — today's visits newest first: arrival number, member ID, name, phone, gender, package, next expiry, time in/out and a Paid / Unpaid / Expiring / Balance due / Frozen status from `services/liveBoard.js`, plus the day's counts; paid = walked in on an active, frozen or still-running cancelled membership, each member counted once by their latest visit; the desk board's `/api/desktop/recent` rows carry `end_date_label`), `attendance/controller/attendanceCorrectionController.js` (`PATCH /api/attendance/records/:id` {checkInAt?, checkOutAt?, note} — fix times, note required, history kept in `edits[]`; `POST /api/attendance/records/:id/void` {reason} — a voided visit is left out of every total, pay and the member's history; `GET/PUT /api/attendance/settings` — `attendance.memberScanOut`, off for gyms where members only scan in; `attendance.voice` { enabled, expiredMessage, expiringMessage, balanceDueMessage } — what the desk and kiosk say after the alert sound, a blank message being the default; a member punch carries `detail.alert` { level: ok / warning / problem, speech } from `punchService.memberAlert`; money still owed on the member's paid orders (every `payment.balanceDue` > 0 added up, as the Dues list counts it -- not only the order described; per currency, the gym's own when owed in two, `peopleDirectory.owedTotals`) never blocks entry — the punch carries the amber warning "Balance due £25" (`detail.balance_due`, `balance_due_label`), the warning sound and the balance message, and the visit keeps `membership.balanceDue` / `currency` so the check-out repeats it), `attendance/controller/fingerprintAdminController.js` (`GET /api/attendance/fingerprints`, `DELETE /api/attendance/fingerprints/:personType/:personId[/:finger]`), `attendance/controller/faceController.js` (`GET /api/attendance/faces` — the same shape: ?q, ?person_type, ?show=unreadable\|departed, paging, `summary`; `DELETE /api/attendance/faces/:personType/:personId`) | `/admin/attendance` (Today · live — refreshes every 15 s while the tab is visible; Edit times, Void, Desk settings), `/admin/fingerprints` | — | `attendance` (manage to change) |
| Check-in: desk code by phone, fingerprint, face, staff by hand | KIOSK.md. `attendance/services/deskCode.js` + `controller/deskCodeController.js` (`POST /api/desktop/checkin-code` — the screen's rotating `GPD1.` code, 60 s; `POST /api/attendance/me/checkin` {code, request_id?} — the signed-in account checks itself in at the desk that showed it, method `desk_code`, ten a minute per account); `controller/faceController.js` + `models/faceTemplateModel.js` (`POST /api/desktop/face-templates`, `face-enroll` with `consent: true`, `face-remove`; the person's own `GET/DELETE /api/attendance/me/face`); `controller/desktopAppController.js` `POST /api/desktop/punch` (`method` fingerprint, face with `match_score`, or manual; `ignored: true` on a repeat scan; `qr` / `code` are `400 METHOD_REMOVED`, `GET /api/attendance/me/qr` is `410`) | Windows desk app (fingerprint, face, person picker, the code on screen); `/kiosk` (shows the code; the staff unlock opens search and checking in by hand) | `/checkin` (opened by the phone's camera, or the member area's scanner); member app scanner; face on file and its removal | desk token (`allowAttendanceApp`; `allowFingerprintEnrollment` to register or remove fingers and faces); any signed-in account for its own check-in and face |
| Accounts (overview, sales, expenses, asset register) and expense / asset heads | `accounts/controller/{accountsController,expenseController,assetController,categoryController}.js`, `accounts/services/{ledger,categories,profitAndLoss}.js`, `accounts/models/{expenseModel,assetModel,categoryModel}.js` — heads are the built-in lists plus the gym's own (`gym_accounts_categories` {kind, key, label, archived}; `GET/POST /api/accounts/categories`, `PUT /api/accounts/categories/:id` {label?, archived?}): a head's key is fixed at creation, renaming changes the label everywhere, archiving stops it being offered for new rows while old rows keep it; no two heads of a kind share a name. The asset register filters by purchase date (`?from=&to=`, either end open; none = every date) and by `?service=due` / `?warranty=ending` (the bell's links). The overview's `profit_and_loss` (also its `result` and trend): revenue — membership fees, admission fees, trainer fees (the payment pipeline's split), shop / POS takings, less refunds — and outflow — trainer commission (a membership's `trainerAssignment.commissionAmount` on its first payment, or first instalment, taken back by a refund as a negative entry on the refund's date — the whole commission for a full refund, the refunded share of the money received (`refund.amount / payment.amountPaid`) for a partial one — plus completed PT sessions' commission), paid expenses, assets bought in the period, paid payslips — each cost once: a payslip's salary expense and an asset's linked purchase expense stand aside (`set_aside`), and salaries are the payslip less its PT commission. The sales list's `?method=` keeps the payments made that way -- each part of an order paid in parts by its own method, as the totals by method count it; refunds by the order's method. Its `?q=` matches the order number, name, email and phone on the order, and the member ID (`memberCode`) or phone on the member's account; a phone matches by its digits, however it is typed | `/admin/accounts` (Manage heads on Expenses and Assets) | — | `accounts` (manage to change) |
| Staff leave, payslips, roster | `models/leaveRequestModel.js`, `models/payslipModel.js`, `services/payrollService.js`, `controller/hrController.js` | `/admin/staff/{roster,leave,payslips}` | My work tab (staff accounts) | `staff` |
| Shop / POS, stock | `models/productModel.js`, `saleModel.js`, `stockMovementModel.js`, `controller/posController.js` | `/admin/pos`, `/admin/inventory` | Receipts on profile | `pos` |
| Till sales (basket and payment) | `controller/posController.js` (`GET /admin/pos/products` also answers `tax_rate` from Settings so the basket shows line totals, discount, the included tax and the total before payment, worked out as `POST /admin/pos/sales` works them out: tax-inclusive prices, discount off the whole basket, tax on the taxable lines' share; `paymentMethod` one of cash, card, bank_transfer, jazzcash, easypaisa, wallet (another mobile wallet), online, account, other — anything else is 400, never read as cash; `tendered` on a cash sale records the cash received and the change, refused when less than the total, ignored for other methods) | `/admin/pos` basket | — | `pos` (manage to sell) |
| Till receipts (thermal) | `controller/posController.js` (`GET /admin/pos/receipt-settings` — `settings.receipt` {paperWidth `80mm` or `58mm`, showLogo, footerText up to 300 characters; an empty footer prints `invoice.footerNote`} with the gym's name, logo, address, phone, email and `invoice` tax label and number; `PUT` {paperWidth?, showLogo?, footerText?} changes only what is sent and refuses anything else with 400) | `/admin/pos` (Receipt settings; Print sends the receipt alone to the printer, one page as long as the receipt and as wide as the roll — `components/receipts/`) | — | `pos` (read at view, change at manage) |
| Till sales history, export, profit | `controller/posController.js` (`GET /admin/pos/sales?from=&to=` — local calendar days, this month by default; the list shows the latest 500 (`truncated` when there are more), the summary covers every paid sale in the range; `GET /admin/pos/sales/export?from=&to=` — every sale in the range as CSV (`services/csv.js`), refunded ones marked. For `pos` at manage only: each line's `unit_cost`, `cost` and `margin` (line total less cost), each sale's `cost` and `profit` (total, less the tax included in it, less cost — so the basket discount comes off it; `services/saleMoney.js`, the rule the reports' top products follow too), the range's `cost` and `gross_profit` per currency, and Cost and Profit columns in the CSV; cost is the product's cost when it was sold, kept on the line) | `/admin/pos` (Sales: dates, presets, Export CSV; cost and profit for manage) | — | `pos` (view; cost and profit at manage) |
| Lockers | `models/lockerModel.js`, `controller/posController.js` | `/admin/lockers` | Locker on profile | `lockers` |
| Dashboard | `controller/dashboardController.js` (`GET /admin/dashboard` — today: revenue = memberships + admission fees + trainer fees (`revenue_today.trainer_fees`, apart from memberships as on Daily sales and the P&L) + shop, less membership refunds given today; paid expenses by the accounts rule; members in split paid / unpaid by the attendance live board's rules (`attendance/services/liveBoard.js`): each member once, by their latest visit today's membership snapshot — paid = `active`, `frozen` or `cancelled` (still running), unpaid = `expired`, `past_due`, `pending`, `suspended`, `none`; a paid member still owing (`membership.balanceDue`) also counts as balance due -- only a paid one: an unpaid member owing on an old order is unpaid, so the owing count is part of the paid one; fees due = live memberships ending in the next 7 days, 8 listed. This month: revenue, paid expenses, members who joined) | `/admin` (fees due → `/admin/fee-expiry?days=7`) | — | `dashboard` |
| Reports & exports | `controller/reportsController.js`, `services/csv.js`, `services/xlsx.js` (every export as CSV, or as a real Excel workbook with `?format=xlsx` — amounts as numbers, dates as dates, bold header; written by hand on Node's zlib, no dependency). `registrations` = members who joined, per local day (the days with any); the Members export lists those who joined in the range, or everyone with `?all=1`. Net = the accounts screen's `result.net` for the same range: membership payments less refunds given in the range, plus paid shop sales, less **paid** expenses dated by `incurredOn` (the period a cost belongs to, not the day it was paid); pending expenses are shown (`expenses_pending`), never deducted; a row with no currency counts as the gym's own. `top_products` (the eight best sellers in the base currency): `quantity`, `total` (their line totals) and `margin` — the till's profit on the product (`services/saleMoney.js`): each line's share of its sale's total less the tax in it, less the line's cost, so the products add up to the till's `gross_profit` | `/admin/reports` (Overview and Daily sales tabs; Print / PDF — the browser's print, laid out as an A4 report with the gym's name and the range) | — | `reports` |
| Daily sales report | `services/dailySales.js`, `controller/reportsController.js` (`GET /admin/reports/daily-sales?from=&to=`; `GET /admin/reports/export/daily-sales` as CSV — totals as the last row — or `?format=xlsx` — a Daily sales sheet with a bold totals row and a By payment method sheet). Every day in the range: new sign-ups (first payments' membership share), renewals (membership share of Stripe's renewals and of the first payment of an order that renewed or replaced another -- a desk renewal or a package change, `renewedFrom` -- as the Overview counts renewals), admission fees, trainer fees, dues collected (instalments, whole), membership refunds given that day (negative), POS sales still paid; the columns add up to the day's total, which is that day's income on the accounts screen. Totals by payment method (memberships, refunds and the till together; cash, card, online card, bank transfer, JazzCash, Easypaisa, other mobile wallet). The split is read from the ledger's payment rows (`admission`, `trainerFee`, `membership`, `kind`, per-payment `method`); a row without it counts wholly as membership money. Gym currency only; other currencies counted and left out | `/admin/reports?tab=daily` | — | `reports` |
| Website: SEO, map, hours, language, embed, domains | `settings.seo/maps/openingHours/locale`, `platform/vercelDomains.js` | Settings → General → Website; platform panel domains | `/embed/timetable`, JSON-LD, language switcher | `settings` |
| Gym timezone | the gym's platform record `locale.timezone` (`platform/tenantContext.js` `tenantTimezone()`), the zone every local day is filed in; `GET /settings` and `GET /settings/public` answer it as `ianaTimezone` — the public one for every admin role, so the admin pages' "today" (date pickers and presets: the frontend's `helper/date.ts` `gymDateKey`) is the gym's day wherever the browser is, falling back to the browser's own date until it is known | Settings → General (Timezone) | — | `settings` (to change) |
| Business details (name, contact, description, social links) | `settings.siteName/contactEmail/mobileNumber/address/siteDescription` and `facebookUrl/instagramUrl/twitterUrl/youtubeUrl/tiktokUrl` — the same names in `PUT /settings`, `GET /settings`, `GET /settings/public` and `services/branding.js`; a social link must be http(s) (a bare `instagram.com/…` gains `https://`), anything else is a `400` | Settings → General → Business | Footer links, contact page, JSON-LD (`siteDescription` stands in for an empty `seo.description`), member app "contact us" | `settings` |
| PWA | — | — | `manifest.ts`, `public/sw.js` | — |
| Marketing site + platform panel (plans, gyms, demo requests, self-serve sign-up) | `platform/routes/platformRoutes.js`, `platform/controllers/{gymsController,plansController,demoRequestsController,signupController}.js`, `platform/services/signupProvisioning.js`, `platform/models/demoRequestModel.js` — sign-up in BILLING.md → *Self-serve sign-up* | `GymPilot_marketing` (`/` landing, `/checkout`, `/super-admin` panel) | — | super admin session (public routes under `/api/platform/public`) |

## Online payments

Each gym takes online payments through ONE gateway of its own choosing,
`settings.onlinePayments.provider`: `stripe` (cards worldwide; Stripe renews
its own subscriptions), `safepay` (Pakistan: card, JazzCash, Easypaisa or any
bank app, straight into the gym's own account; payment links; optional
automatic card payments) or `generic` (bank transfer with an uploaded
receipt, any country; ready once the gym has an active bank account under
Settings → Banks). Unset — a gym from before the choice — it reads as
`stripe` when Stripe is on and `none` otherwise, and is stored only once the
gym actually chooses. The choice decides whether Safepay is on
(`safepay.enabled` follows it). Every gateway is one module in
`services/payments/providers` with one interface (listed in
`services/payments/index.js`); checkout, payment links and automatic charges
go through `payments.activeProvider()` / `providerForCheckout()`, never a
gateway directly, so a new gateway is a new module. GymsPilotPro never holds
the money.

* `GET /settings/payment-gateways` (settings view) — `{ data: [{ id, label,
  description, countries, checkout_label, capabilities: { checkout,
  paymentLinks, receiptUpload, savedCards, autoCharge, wallets, bankApps },
  settings_key, config_fields: [{ name, label, type, secret, required,
  options?, help? }], configured, selected, webhook_url }], selected }`. A
  gateway's fields live at `settings[<settings_key>][<name>]`.
* `POST /settings/<gatewayId>/test` (`stripe` as before, `safepay`,
  `generic`; also `/settings/payment-gateways/:id/test`; settings manage) —
  `{ success, message }`: the typed keys, or the saved ones for a field left
  masked. Safepay is asked for a checkout token and a payment session that is
  never paid; generic says how many bank accounts are ready.
* `PUT /settings` takes `onlinePayments: { provider }`, `safepay: { enabled,
  environment: 'sandbox'|'production', publicKey, secretKey, webhookSecret }`
  (secrets masked on the way out with `secretKeySet` / `webhookSecretSet`,
  kept when sent back masked, sealed at rest; switching Safepay on without
  the secret key, webhook secret or API key is 400 `SECRET_REQUIRED` naming
  the field, nothing saved) and `billing: { reminderDaysBefore: [0..30],
  dueDayReminder, lastDayAfterDue: 0..30, sendVia: { email, sms, whatsapp,
  push }, autoCharge: { enabled } }` (400 naming a field that cannot be used).
  `GET /settings` adds `onlinePayments.providerChosen` and the read-only
  `safepay.webhook_url` (`https://<API host>/api/payments/safepay/webhook/<slug>`).
* `GET /api/gymfolio/payment/methods` adds `online: { provider, label,
  checkout, auto_pay_available } | null` (Safepay: "Card, JazzCash, Easypaisa
  or any bank app"; Stripe: "Card"; generic: "Bank transfer — upload your
  receipt", `checkout: false`). `card` is whether the online checkout can be
  used now, through whichever gateway; `auto_pay_available` whether the
  member may opt into automatic card payments.
* `POST /api/gymfolio/payment/create-package-checkout-session` keeps its shape
  (`{ url }`, plus `provider` and, for Safepay, `orderId`). At a Safepay gym it
  records the pending order (method `online`, `payment.provider: 'safepay'`;
  price, joining fee and coupon worked out on the server exactly as for
  Stripe; the term sold as one period) and opens Safepay's hosted checkout,
  returning to `<gym's primary domain>/checkout/success?provider=safepay&order=<orderId>`
  (cancel: `/checkout/cancel?order=<orderId>`) — the primary domain of the
  platform record (`services/payments/site.js`), never Settings → siteUrl or
  the request. `saveCard` + `autoPayConsent` (both `true`) keep the card for
  automatic payments — only for a signed-in member at a gym with
  `billing.autoCharge.enabled`. A generic gym answers 409 `BANK_TRANSFER_ONLY`.
* `GET|POST /api/gymfolio/payment/verify/<orderId>?provider=safepay[&tracker=]`
  answers from the order (the webhook may have recorded it), else asks
  Safepay; 404 `ORDER_NOT_FOUND` for no such Safepay order. A Stripe session
  id still goes to Stripe.
* `POST /api/gymfolio/package-orders/:id/pay-online { saveCard?, autoPayConsent? }`
  (the member, own order) — `{ url, purpose: 'order'|'balance', amount, reference }`
  for an unpaid order meant for online payment (a renewal) or a part-paid
  order's balance.
* `POST /api/payments/safepay/webhook/:gymSlug` — Safepay's events: raw body,
  `X-SFPY-SIGNATURE` (HMAC-SHA512) checked with that gym's webhook secret; a
  payment is applied once through the same activation path Stripe's takes
  (term continuing from the running one, coupon, invoice number,
  confirmation) or as one more installment on a balance; a failed attempt
  leaves the order payable; refunds are noted, not acted on.
* Saved cards: `user.billing.savedMethods[]` (`select: false`): `{ id,
  provider, token (sealed), customerToken, brand, last4, expMonth, expYear,
  autoPay, consentAt, consentText, createdAt }` — Safepay's token for the
  card, never card data. `services/safepay` exports `getSafepayConfig`,
  `createCheckout`, `chargeSavedMethod` (Safepay `unscheduled_cof`),
  `fetchTrackerStatus`, `verifyWebhook`, and `listSavedMethods`,
  `autoPayMethodFor`, `removeSavedMethod` for the payment links and the
  automatic charge.

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
  (`test/integration/helpers/harness.js`); Safepay is a stand-in HTTP server
  on a local port (`test/integration/helpers/fakeSafepay.js`). `.env` is never read, and every
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
