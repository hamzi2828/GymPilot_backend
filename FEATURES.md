# GymPilot feature map

Where each part of the product lives, what it stores, and the permission tab
that gates it. Every collection is per gym (see MULTI_TENANCY.md); every
setting is on the gym's `settings` document.

| Area | Backend | Admin UI | Member portal | Permission tab |
|---|---|---|---|---|
| Messaging (SMS / WhatsApp / push, campaigns, announcements, wording, automations) | `services/messaging.js`, `templateService.js`, `campaignService.js`, `automations.js`, `controller/messagingController.js` | `/admin/messaging`, Settings → Messaging | Profile → Notifications (channels, push per device) | `messaging` |
| Member profile (photo, emergency contact, health + PAR-Q, agreement, documents, tags, notes) | `controller/memberProfileController.js`, fields on `models/user.js`, `settings.membership.waiver` | Users → Profile | Profile tab | `users` |
| Leads | `models/leadModel.js`, `controller/leadController.js` (website enquiries become leads) | `/admin/leads` | — | `leads` |
| Booking rules, timetable changes, rooms | `gymfolio/services/bookingRules.js`, `classSessions.js`, `models/classExceptionModel.js`, `controller/classExceptionController.js`; `settings.booking`, `settings.rooms` | Settings → General, `/admin/timetable-changes`, class room field | Timetable shows changes | `classes` |
| Personal training | `gymfolio/models/ptSessionModel.js`, `services/ptService.js`, `controller/ptController.js`; `settings.pt`; trainer `acceptsPt/ptRate/commissionPercent` | `/admin/pt` | Personal training tab | `pt` |
| Staff leave, payslips, roster | `models/leaveRequestModel.js`, `models/payslipModel.js`, `services/payrollService.js`, `controller/hrController.js` | `/admin/staff/{roster,leave,payslips}` | My work tab (staff accounts) | `staff` |
| Shop / POS, stock | `models/productModel.js`, `saleModel.js`, `stockMovementModel.js`, `controller/posController.js` | `/admin/pos`, `/admin/inventory` | Receipts on profile | `pos` |
| Lockers | `models/lockerModel.js`, `controller/posController.js` | `/admin/lockers` | Locker on profile | `lockers` |
| Reports & exports | `controller/reportsController.js`, `services/csv.js` | `/admin/reports` | — | `reports` |
| Website: SEO, map, hours, language, embed, domains | `settings.seo/maps/openingHours/locale`, `platform/vercelDomains.js` | Settings → General → Website; platform panel domains | `/embed/timetable`, JSON-LD, language switcher | `settings` |
| PWA | — | — | `manifest.ts`, `public/sw.js` | — |

## Daily job

`GET/POST /api/jobs/reminders` (CRON_SECRET) runs, per gym: expire lapsed
orders → resume due freezes → membership expiry notices → class reminders →
PT reminders → auto no-shows (if on) → automations (absent / win-back /
birthday, if on). `?dryRun=1` reports without sending.

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
