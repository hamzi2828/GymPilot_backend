# GymPilot billing & memberships

How a gym sells and runs memberships: packages, ways to pay, what happens
after the sale, and the paperwork.

## Packages

`Package` (`src/gymfolio/models/packageModel.js`) — set up under **Fitness →
Packages**.

| Field | Meaning |
|---|---|
| `kind` | `membership` · `session_pack` · `day_pass` · `trial` · `pt_pack` |
| `price` / `priceAmount` | display string the site shows / numeric mirror kept in step on save |
| `period` | label for one-off packages ("month", "3 months", "year") |
| `durationDays` | explicit validity in days; 0 = derive from `period` |
| `billing.mode` | `one_time` (a term paid up front) or `recurring` (Stripe subscription) |
| `billing.interval` / `intervalCount` / `trialDays` | what Stripe bills on, for recurring |
| `sessions` | sessions on a pack (packs expire when used up or when `durationDays` passes) |
| `joiningFee` | charged once, on top of the first payment |

## Ways to pay

`GET /api/gymfolio/payment/methods` tells the checkout which are available.

* **Card (Stripe)** — the gym's own Stripe account, keys under **Settings →
  Stripe** (`src/services/stripeClient.js`). One-off packages use Checkout in
  `payment` mode; recurring packages use `subscription` mode and Stripe then
  renews them. The platform's env `STRIPE_*` keys apply only to the gym named
  by `DEFAULT_TENANT_SLUG` (the pre-platform deployment) and never to anyone
  else.
* **Bank transfer** — needs at least one account under **Settings → Banks**.
  Checkout records a pending order (`POST /api/gymfolio/payment/bank-transfer`)
  and shows the bank details; the member attaches a receipt
  (`POST /package-orders/:id/proof`, multipart `proof` + `reference`, `note`);
  staff **Confirm payment received** or **Reject** on Package Orders. The
  member is emailed at each step.
* **At the desk** — **Assign Package** on Package Orders: cash, bank or a card
  terminal, with an optional coupon, amount override and start date.

## Coupons

`Coupon` (`src/gymfolio/models/couponModel.js`) — **Sales → Coupons**.
Percent or fixed amount, optional package list, validity window, max uses,
"applies to renewals". Checked at checkout (`POST /api/gymfolio/coupons/validate`)
and applied to every payment method; on Stripe it becomes a one-off Stripe
coupon on the session. Redeemed when the order is paid.

## After the sale — `src/gymfolio/services/membershipService.js`

Every payment path ends in `markPaidAndActivate()`, which sets the dates,
issues the invoice number, redeems the coupon and activates the order.

* **Start date** — a new *membership* starts when the member's current one
  ends (renewing early keeps the remaining days). Packs and passes start at
  once.
* **Freeze / resume** — `POST /package-orders/:id/freeze {days, reason}` and
  `/unfreeze`. The end date moves out by the frozen days; resuming early
  hands the unused days back. Stripe subscriptions are paused
  (`pause_collection`) for the duration. Members may freeze themselves up to
  **Settings → Max freeze days** (`membership.maxFreezeDays`); the daily cron
  resumes freezes whose date has passed.
* **Cancel / resume** — `POST /package-orders/:id/cancel {reason, immediate}`.
  Members always cancel *at period end* (recurring: Stripe
  `cancel_at_period_end`; one-off: the term simply runs out). Staff may cancel
  immediately. `/resume` undoes a pending cancellation.
* **Renew** — `POST /package-orders/:id/renew` (staff): a fresh term of the
  same package, starting when the current one ends.
* **Change package** — `POST /package-orders/:id/change-package {packageId}`
  (staff): the unused days of the old package are credited pro rata against
  the new price; on a Stripe subscription the subscription item is switched
  and Stripe prorates.
* **Session packs** — `POST /package-orders/:id/use-session` (staff). The desk
  receipt shows sessions left; an exhausted pack reads as expired.
* **Billing portal** — `POST /package-orders/:id/billing-portal` returns a
  Stripe portal URL for updating the card / seeing Stripe receipts.

Order statuses: `pending` → `active` → `expired`; plus `frozen`, `past_due`
(a Stripe renewal failed; Stripe retries), `cancelled`, `suspended`.

## Stripe webhook

Each gym registers **its own** endpoint in its Stripe dashboard:

    https://<api>/api/gymfolio/payment/webhook/<gym slug>

(shown on Settings → Stripe) with its signing secret saved there. Events
handled: `checkout.session.completed`, `payment_intent.succeeded`,
`payment_intent.payment_failed`, `invoice.paid` (renewal → end date extended,
member emailed), `invoice.payment_failed` (→ `past_due`, member emailed a
"update your card" link), `customer.subscription.updated`,
`customer.subscription.deleted`. The legacy `/webhook` URL still works and
finds the gym from the event's metadata.

## Invoices

`src/services/invoiceService.js`. Issued when an order is paid: a gap-free
number per gym (`<prefix>-<year>-<seq>`, prefix under **Settings → Invoices**),
tax shown as *included* in the price at **Settings → Tax rate**, rendered as a
PDF on demand (`GET /package-orders/:id/invoice.pdf`) and attached to the
membership-confirmation email. Members download theirs from the account page;
staff from Package Orders.

## Settings that matter here

Under **Settings → General**: currency (any ISO code), tax rate, timezone,
invoice prefix / tax label / tax number / footer, member self-service
(freeze allowed, max days, cancel allowed). Under **Settings → Stripe** the
keys and the webhook URL. Under **Settings → Banks** the transfer accounts.

## Emails

`src/services/gymNotifications.js`: membership confirmed (+ invoice PDF),
renewed, payment failed, transfer received, transfer rejected, frozen,
cancelled, expiring (14/7/1 days), expired.

---

# Platform billing — GymPilot charging gyms

Everything above is a gym charging its members through the gym's own Stripe
account. This part is the platform charging the gym for its plan, through the
**platform's** Stripe account (keys under the panel's System → Stripe,
`platform_settings`; client in `src/platform/services/platformStripe.js`).
The two are never crossed.

## The subscription record

`gyms.subscription` (`src/platform/models/gymModel.js`): `status`
(`trialing · active · past_due · expired · cancelled`), `billingCycle`,
`amount` (the whole bill per cycle) = `planAmount` + `addons[].amount`,
`currency`, `startedAt`, `currentPeriodEnd`, `cancelledAt`, `notes`, and for
self-serve card payment `stripeCustomerId`, `stripeSubscriptionId`,
`stripePriceSummary` ("Growth (GymPilot) + Member app · PKR 10,400 / month"),
plus `notices` (when each lifecycle email went — see below).

* Provisioning (`subscriptionFor`) starts a gym on a plan as `trialing` with
  `currentPeriodEnd = now + plan.trialDays`. **A plan with `trialDays: 0`
  ends its period *now*** — the first payment is due at once — rather than
  leaving the date empty, so the daily roll-over applies to it. A gym on no
  plan is not billed and has no period end (nothing to roll), unless its
  status is set to `trialing` by hand, in which case it is due now too. The
  roll-over's `$ne: null` guards stay: an empty date still means "never".
* Add-ons only go on a subscription in the **plan's currency**;
  `resolveAddons` answers `400 { message: 'Add-on X is priced in PKR but the
  plan is in USD' }` from `POST /gyms` and `PUT /gyms/:id/subscription`
  (included add-ons cost 0 and are exempt). The marketing site and the panel
  only offer add-ons in the plan's currency.
* `PUT /api/platform/gyms/:id/subscription` treats an explicit
  `currentPeriodEnd: null` as "clear" (a plan then gets a fresh period from
  today); leaving the field out keeps the date. Re-writing the subscription
  from the panel carries the Stripe ids over and resets `notices` when the
  period end moves.
* The daily cron: `trialing / active → past_due` when `currentPeriodEnd`
  passes — for a gym Stripe bills (`stripeSubscriptionId` set) two days
  later (`STRIPE_SETTLE_DAYS`), because Stripe charges about an hour after
  the period ends and the webhook then moves the period on — and
  `past_due → expired` `SUBSCRIPTION_GRACE_DAYS` after the period ended.
  `expired` and `cancelled` gyms answer `402 { code: 'SUBSCRIPTION_INACTIVE',
  renewable: true }`; `suspended` gyms `403`.
* **Renewing a lapsed gym.** A `402 SUBSCRIPTION_INACTIVE` gym still answers
  `POST /user/login`, `POST /user/login/2fa` and `/api/billing/*` (each still
  behind its own sign-in / `auth` + Settings permission); everything else
  keeps the 402. The website shows the "subscription is not active" page with
  a **Sign in to renew** form: the owner signs in, is sent to Stripe Checkout,
  and on return (`?billing=success`) the page waits for the webhook to
  reactivate the gym, then reloads. Suspended and unknown gyms get no
  exception.

## Paying by card — `src/platform/services/platformBilling.js`

Tenant-side routes (`src/platform/routes/billingRoutes.js`, mounted at
`/api/billing` **after** the tenant gate, `auth` + Settings permission):

| Route | Permission | Answer |
|---|---|---|
| `GET /api/billing/subscription` | settings · view | `{ success, data: { plan: { name, slug, price: { monthly, yearly, currency }, trialDays } \| null, status, billingCycle, currentPeriodEnd (ISO \| null), daysLeft (number \| null), amount, currency, addons: [{ slug, name, amount }], stripeConfigured, hasStripeSubscription, contactEmail } }` |
| `POST /api/billing/checkout` `{ billingCycle? }` | settings · manage | `{ success, data: { url } }` — a Stripe Checkout Session in `subscription` mode. `409 { code: 'PLATFORM_STRIPE_NOT_CONFIGURED' }` when the platform has no keys (or charging is switched off); `409 { code: 'ALREADY_SUBSCRIBED' }` when the gym already has a Stripe subscription that is `trialing`, `active` or `past_due` (use the portal instead); `400 { code: 'NO_PLAN' }` when the gym is on no plan. Returns to `<siteUrl>/admin/settings?tab=billing&billing=success` / `&billing=cancelled`. |
| `POST /api/billing/portal` | settings · manage | `{ success, data: { url } }` — the Stripe customer portal, returning to `<siteUrl>/admin/settings?tab=billing`; `409 { code: 'NO_STRIPE_CUSTOMER' }` before the gym has ever paid. |

The gym admin's **Settings → Billing** tab (`?tab=billing`) is built on these:
plan, status, period end, amount and add-ons for anyone with Settings · view;
**Subscribe** (monthly / yearly when the plan has a yearly price) or **Manage
billing** for Settings · manage. The admin shell shows Settings viewers a
banner when a trial has 14 days or less left, or a payment is overdue.

`contactEmail` is `PLATFORM_CONTACT_EMAIL`. The checkout builds inline prices
(`line_items[].price_data`, `recurring.interval` month/year,
`product_data.name` "<Plan> (GymPilot)", `unit_amount` in minor units via
`helper/money.toMinorUnits` — zero-decimal currencies handled) from the
gym's agreed plan price and one line per paid add-on, in the plan's currency.
`customer` is the existing `stripeCustomerId`, else `customer_email` is the
owner's; `client_reference_id` is the gym id and `metadata` /
`subscription_data.metadata` carry `{ gymId, gymSlug, planSlug, billingCycle }`.
A gym still trialing with at least 48 hours left passes
`subscription_data.trial_end = currentPeriodEnd`, so the card goes on file now
and is first charged when the trial ends; a shorter remainder is charged now.

## Platform webhook — `POST /api/platform/stripe/webhook`

Raw body, signature checked against the stored signing secret, applied by
`src/platform/services/platformWebhook.js`, **idempotent**: every event id is
claimed in `platform_stripe_events` (unique on `eventId`) before anything
changes, so a redelivery is acknowledged and skipped. A handler that throws
releases the claim and answers 500 so Stripe retries; a claim left unfinished
(no `handledAt`) for more than 10 minutes — the request died before it could
release it — is taken over by the next delivery. Every event is written to
the audit log as `platform_stripe_event` with its `result`.

Stripe delivers out of order, so two guards keep a late event from undoing
newer state: an event about a subscription that is not the gym's current
`stripeSubscriptionId` (an old one it replaced, or the one that was deleted
and cleared) is ignored — only `checkout.session.completed` makes a
subscription current — and an event created before
`subscription.stripeEventAt` (the newest one applied) is ignored, checked
atomically in the write.

The platform's Stripe secret key and webhook secret are sealed at rest with
`src/services/secretBox.js` (always with the un-scoped key, whichever gym's
request reads them); values saved before sealing still read as plaintext and
are sealed on the next save. The API only ever returns them masked.

| Event | Effect on the gym |
|---|---|
| `checkout.session.completed` (mode subscription) | `stripeCustomerId`, `stripeSubscriptionId`, `status` (`active`, or `trialing` while Stripe trials; a status not recorded, such as `incomplete`, leaves it unchanged; when the subscription cannot be read the event fails so Stripe redelivers it), `billingCycle` from metadata, `amount` / `currency` from the subscription's items, `currentPeriodEnd` from `current_period_end` **or** `items.data[0].current_period_end` (newer API versions moved it), `startedAt` |
| `invoice.paid` | gym found by `invoice.subscription` or `invoice.parent.subscription_details.subscription`; `currentPeriodEnd` extended (never shortened) to the invoice's line period end, `status: 'active'` when something was paid (a zero trial invoice leaves the trial standing) |
| `invoice.payment_failed` | `status: 'past_due'` |
| `customer.subscription.updated` | status synced (`trialing / active / past_due / unpaid→past_due / canceled→cancelled`), period end, amount, cycle |
| `customer.subscription.deleted` | `status: 'cancelled'`, `cancelledAt`; the customer id is kept, the subscription id cleared |

Every change calls `invalidateTenantCache()`; a period end moving forward
clears `notices`. Unhandled event types are acknowledged with 200.

## Owner lifecycle emails — `jobs.sendOwnerBillingNotices({ dryRun })`

Called by the cron after `rollSubscriptionStatuses`. For every active gym
with an owner email, once each (recorded in `subscription.notices`):
trial ending in 7, 3 and 1 days (`trial7 / trial3 / trial1`; when the cron
missed days only the most urgent goes out and the rest are marked), moved to
`past_due` (`pastDue`), `expired` (`expired`). Each email names the gym and the
date and links to `<siteUrl>/admin/settings?tab=billing` to subscribe or update
the card (an expired gym's owner lands on the "Sign in to renew" page there),
branded `PLATFORM_NAME` (default GymPilot) and sent with the platform's own
SMTP (env). The decision is the pure `noticesDue(subscription, now)` in
`src/platform/billingNotices.js` (unit-tested). With `dryRun` the job returns
what it would send and marks nothing.

## Entitlements

`src/platform/entitlements.js`: `gymHasAddon(gym, 'member-app')` — true with
no plan, when the plan includes the add-on, or when the subscription carries
it. See MULTI_TENANCY.md.
