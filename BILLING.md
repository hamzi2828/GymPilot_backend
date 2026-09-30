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
| `joiningFee` | charged once, on top of a member's first membership: not to anyone who has had a paid (or refunded) membership before, and never on a renewal or a package change (`membershipService.joiningFeeDue`) |

A package members still hold cannot be deleted: `DELETE /packages/:id`
answers `409 { code: 'PACKAGE_IN_USE', live, renewable }` while any order
for it is running or awaiting payment (`live`), or is a lapsed membership
that is still its member's latest order (`renewable` — the desk may renew
it, and renewing reads the package). Deactivate it instead; the Packages
screen offers that on the refusal.

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
* **At the desk** — **Assign Package** on Package Orders: cash, bank, a card
  terminal or a mobile wallet (JazzCash, Easypaisa, other), with an optional
  coupon, amount override and start date.

`payment.method` is one of `src/services/paymentMethods.js`: `stripe` (Card
(Stripe)), `card` (Card — the desk terminal), `bank_transfer`, `cash`,
`jazzcash`, `easypaisa`, `wallet` (Other mobile wallet); invoices and the
admin screens show those labels. Staff may record any of them but `stripe`,
which is only ever paid through checkout. A method outside the list — or
`stripe` at the desk — is refused with `422 PAYMENT_METHOD_INVALID`, never
recorded as cash.

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
`currency`, `startedAt`, `currentPeriodEnd`, `cancelledAt`, `pastDueSince`
(when it went past due; `null` whenever it is not), `notes`, and for
self-serve card payment `stripeCustomerId`, `stripeSubscriptionId`,
`stripePriceSummary` ("Growth (GymPilot) + Member app · PKR 10,400 / month"),
`checkoutSessionId` (the Stripe Checkout page the Billing tab opened last,
cleared once it is paid), plus `notices` (when each lifecycle email went —
see below).

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
  `past_due → expired` `SUBSCRIPTION_GRACE_DAYS` after the period ended
  **or after `pastDueSince`, whichever is sooner** (`rollFilters` `toExpired`
  / `toExpiredPastDue`). The second rule is what cuts off a gym whose card
  keeps failing: Stripe moves `current_period_end` on at every renewal, paid
  or not, so the period end alone kept such a gym served for ever.
  `pastDueSince` is set by the webhook (the event's time) or the cron when a
  gym goes past due, kept while it stays there, and cleared by any other
  status; a past-due gym without one (past due before it existed, or
  re-saved from the panel) gets today's (`past_due_clock_started` in the
  answer). An expired gym stays expired through Stripe's further retries
  (`invoice.payment_failed` → `already expired`; a `past_due`
  `customer.subscription.updated` leaves the status alone) until it is
  paid. `expired` and `cancelled` gyms answer `402 { code:
  'SUBSCRIPTION_INACTIVE', renewable: true }`; `suspended` gyms `403`.
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
| `GET /api/billing/subscription[?usage=0]` | settings · view | `{ success, data: { plan: { name, slug, price: { monthly, yearly, currency }, trialDays } \| null, status, billingCycle, currentPeriodEnd (ISO \| null), daysLeft (number \| null), amount, currency, addons: [{ slug, name, amount }], stripeConfigured, hasStripeSubscription, contactEmail, usage } }`. `usage` is `[{ key, label, used, limit }]`, one per plan limit (`members`, `staff`, `trainers`, `classes` — `planLimits.LIMIT_KINDS`), counted by the same functions the limits are enforced with (the owner is not counted as staff); `limit: null` means unlimited (0, or no plan). `usage` is `null` when a count failed, and with `?usage=0`, which skips the counts — the admin shell's billing banner asks on every page load and needs only the status. |
| `POST /api/billing/checkout` `{ billingCycle?, planSlug? }` | settings · manage | `{ success, data: { url } }` — a Stripe Checkout Session in `subscription` mode. `planSlug` subscribes to another active plan than the gym's (the plan picker): priced as that plan (`subscriptionForPlanChange`), and the webhook moves the gym to it once paid. The page opened last time (`subscription.checkoutSessionId`) is expired first, so two tabs cannot start two subscriptions: `409 { code: 'CHECKOUT_COMPLETED' }` when it was paid a moment ago and the webhook has not recorded it yet, `502` when Stripe would not close it. `409 { code: 'PLATFORM_STRIPE_NOT_CONFIGURED' }` when the platform has no keys (or charging is switched off); `409 { code: 'ALREADY_SUBSCRIBED' }` when the gym already has a Stripe subscription that is `trialing`, `active` or `past_due` — **or an `expired` gym whose Stripe subscription Stripe still has open** (past due / unpaid: pay it in the portal; a second checkout would start a second subscription) — the renew page answers it by opening the portal; `400 { code: 'NO_PLAN' }` when the gym is on no plan and names none. Returns to `<siteUrl>/admin/settings?tab=billing&billing=success` / `&billing=cancelled`. |
| `POST /api/billing/portal` | settings · manage | `{ success, data: { url } }` — the Stripe customer portal (card, invoices, cancelling — not plan changes), returning to `<siteUrl>/admin/settings?tab=billing`; `409 { code: 'NO_STRIPE_CUSTOMER' }` before the gym has ever paid. |
| `GET /api/billing/plans` | settings · view | `{ success, data: [{ slug, name, description, price: { monthly, yearly, currency }, limits: { maxMembers, maxStaff, maxTrainers, maxClasses }, features, trialDays, current }] }` — the active plans, the gym's own marked `current`. Limits of 0 are unlimited. |
| `POST /api/billing/change-plan` `{ planSlug, billingCycle? }` | settings · manage | Moves a gym Stripe bills (`trialing` / `active` with a `stripeSubscriptionId`) to another active plan and/or cycle, Stripe first (`subscriptionSync.syncStripeSubscription`, as the panel does it: items replaced, `proration_behavior: create_prorations`, `payment_behavior: error_if_incomplete`) — an upgrade charges the difference for the rest of the period now, a downgrade is credited to the next invoice, a trial is charged nothing until it ends. Only then is the gym written: `plan`, `billingCycle`, `planAmount` (the new plan's list price), `addons` (the paid ones kept, the new plan's included ones), `amount`, `stripePriceSummary`; audit `gym_plan_changed`. `{ success, message, data: { plan: { name, slug }, billingCycle, amount, currency } }`. Refusals: `404 PLAN_NOT_FOUND`, `400 CYCLE_NOT_OFFERED` (no price for that cycle, or a free plan), `400 SAME_PLAN`, `409 NO_STRIPE_SUBSCRIPTION` (subscribe through checkout with `planSlug` instead), `409 PAYMENT_OVERDUE` (fix the card first), `409 CURRENCY_MISMATCH` (a running subscription cannot change currency), `409 PLATFORM_STRIPE_NOT_CONFIGURED`, and Stripe's own refusal (`409` / `502`, nothing written). |

The gym admin's **Settings → Billing** tab (`?tab=billing`) is built on these:
plan, status, period end, amount, add-ons and a **Plan usage** meter (from
`usage`) for anyone with Settings · view; **Subscribe** (monthly / yearly when
the plan has a yearly price) or **Manage billing** for Settings · manage, and
a **Change plan** picker (every active plan with its price per cycle and its
limits, the gym's own marked, a confirm dialog that says how the change is
charged) — `change-plan` for a gym Stripe bills, checkout with `planSlug`
otherwise; not shown to a gym billed by hand or one whose Stripe
subscription is waiting on a payment. The plan-limit warning points at it.
The admin shell shows Settings viewers a banner when a trial has 14 days or
less left, or a payment is overdue.

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
| `checkout.session.completed` (mode subscription) | With `metadata.kind: 'signup'` there is no gym yet: the event builds one (see *Self-serve sign-up* below), then applies the rest of this row to it. Otherwise: `stripeCustomerId`, `stripeSubscriptionId`, `status` (`active`, or `trialing` while Stripe trials; a status not recorded, such as `incomplete`, leaves it unchanged; when the subscription cannot be read the event fails so Stripe redelivers it), `billingCycle` from metadata, `amount` / `currency` from the subscription's items, `currentPeriodEnd` from `current_period_end` **or** `items.data[0].current_period_end` (newer API versions moved it), `startedAt`. When `metadata.planSlug` names another plan than the gym's (checkout with `planSlug`), the gym moves to it: `plan`, `planAmount`, `addons` as `subscriptionForPlanChange` priced them. `checkoutSessionId` is cleared when it is this page. |
| `invoice.paid` | gym found by `invoice.subscription` or `invoice.parent.subscription_details.subscription`; `currentPeriodEnd` extended (never shortened) to the invoice's line period end, `status: 'active'` when something was paid (a zero trial invoice leaves the trial standing) |
| `invoice.payment_failed` | `status: 'past_due'` (`already expired` for an expired gym: it stays cut off until paid) |
| `customer.subscription.updated` | status synced (`trialing / active / past_due / unpaid→past_due / canceled→cancelled`; `past_due` does not un-expire an expired gym), period end, amount, cycle |
| `customer.subscription.deleted` | `status: 'cancelled'`, `cancelledAt`; the customer id is kept, the subscription id cleared |

Every change calls `invalidateTenantCache()`; a period end moving forward
clears `notices`; a status write starts, keeps or clears `pastDueSince`
(`withStatusEffects`). Unhandled event types are acknowledged with 200.

## Self-serve sign-up — `src/platform/controllers/signupController.js`

A buyer on the marketing site's checkout (`GymPilot_frontendAdmin` `/checkout`)
can pay and get a gym with nobody in the panel involved. Their answers are
kept as a demo request of `kind: 'signup'` (`platform_demo_requests`) with a
`signup` block — `state` `awaiting_payment → provisioning → ready`, or
`failed` with an `error` — and the panel's **Demo requests** page lists them
with that state.

Public routes (`src/platform/routes/platformRoutes.js`, no session):

| Route | Answer |
|---|---|
| `GET /api/platform/public/config` | `{ success, data: { root_domain, self_serve_signup } }` — `self_serve_signup` is `selfServeAvailable()` as a yes / no, never why. Checkout pays online when it is true; otherwise it sends a request (`kind: 'trial'`) for the panel, as before. |
| `POST /api/platform/public/signup` (`paymentLimiter`: 30 per 15 minutes) | The checkout form: `firstName`, `lastName`, `email`, `gymName`, `planSlug` required; `billingCycle`, `addonSlugs`, `preferredSlug`, `phone`, `gymSize`, `country`, `message`, `source`, `timezone` (the browser's) optional; `website` is the honeypot. `201 { success, id, url }` — the Stripe Checkout page. `409 { code: 'SELF_SERVE_UNAVAILABLE' }` (send a request instead; also for a plan that costs nothing), `409 { code: 'SLUG_TAKEN', suggestion }`, `400 { code: 'SLUG_INVALID' }`, `409 { code: 'SIGNUP_IN_PROGRESS' }` (this email already paid for a gym still being set up), `400` for a missing field or a plan no longer on sale, `502` when Stripe could not open the page (nothing charged). |
| `GET /api/platform/public/signup/:id/status` | `{ success, data: { status, message, siteUrl?, trialEndsAt? } }` — polled by the success page (`/checkout/success?signup=<id>`); nothing personal. `404` for an id that is not a signup. |

**Prerequisites.** `selfServeAvailable()` is true only when all of these hold:

* `PLATFORM_SELF_SERVE_SIGNUP` is not `off` / `0` / `false` / `no` (unset is on);
* `PLATFORM_ROOT_DOMAIN` is set — a self-served gym's only web address is
  `<slug>.<root>`, and provisioning refuses a gym with none (`requireSite`);
* the platform's Stripe secret key is saved and charging is switched on
  (panel → System → Stripe);
* a webhook signing secret is saved there too, or no payment could ever
  create its gym;
* `SMTP_HOST`, `SMTP_USER` and `SMTP_PASS` are all set — a gym made a moment
  ago has no email settings of its own, so its owner's set-password link
  goes out through the env SMTP, and without it the buyer would pay and
  never get into their gym.

`PLATFORM_ADMIN_ORIGIN` is not checked, but Stripe sends the buyer back to it:
`<origin>/checkout/success?signup=<id>`, or `<origin>/checkout?plan=…&cycle=…&cancelled=1`
— the request's own `Origin` when it is one of the listed origins, else the
first one listed (`http://localhost:3001` when unset). The platform webhook
must be registered with `checkout.session.completed` (DEPLOYMENT.md §2).

**Before anyone pays** the selection is priced on the server
(`priceSelection`, as for a checkout request) and the web address is checked
free: a valid, unreserved slug that is no gym's slug or `<slug>.<root>` host,
and not held by another buyer's signup that reached Stripe (held for 24 hours
while unpaid, and while it is being set up or has failed). The same buyer's
unpaid signup is reused rather than duplicated, its earlier Stripe page
expired first so they cannot pay on both; one of theirs that paid (being set
up, or failed within the last three days) answers `SIGNUP_IN_PROGRESS`.

**The Checkout Session** (`platformBilling.createSignupCheckoutSession`):
`mode: 'subscription'`, card only, priced inline by `priceLinesFor` from the
very subscription provisioning will write, `customer_email` the buyer's,
`client_reference_id` the signup id, `metadata` and
`subscription_data.metadata` `{ signupId, kind: 'signup', planSlug,
billingCycle }`, and `subscription_data.trial_period_days` the plan's
`trialDays` (at most 730): the card is taken now and first charged when the
trial ends.

**The webhook builds the gym** (`src/platform/services/signupProvisioning.js`).
A `checkout.session.completed` with `metadata.kind: 'signup'` claims the
signup in one atomic write (two deliveries cannot both build), runs the same
`provisionGym` as the panel's **New gym** (with `requireSite`, and the Stripe
customer and subscription written in the same insert as the gym), marks the
signup `ready` with the gym's `siteUrl`, applies the subscription as for any
gym's checkout, and emails the owner their set-password link and every
platform admin a summary (through `services/afterResponse.js`, so the
admins' email is not cut off on Vercel once the webhook has answered; the
same goes for a demo request's two emails). The claim also records the
paid page as `signup.stripeSessionId`. It is safe to run twice: a finished
gym already carrying the signup or the payment's subscription is linked,
never rebuilt — so a gym set up by hand from the request picks the payment
up on the next delivery; one made by a delivery that died before recording
it gets its owner a fresh set-password email (whether the first went is not
known). A gym a dead delivery left half made (no `provisionedAt`, carrying
this payment's subscription and the buyer as owner, older than the stale
window, on the shared cluster) is deleted with its database and made
afresh; any other half-made gym is reported as before. A subscription that
is not `trialing` / `active` yet is waited for.
A failure is written on the signup (`state: 'failed'`, `error`), admins are
emailed the first time, and the webhook answers 500 so Stripe delivers it
again. A second payment for a signup whose gym is on another subscription,
and a payment for a signup whose gym was deleted, are left on no gym and
reported to the admins (the request's `warnings` / `error` say what to cancel
in Stripe).

**Function time limit.** All of that happens inside the webhook request —
the database, roles, settings, homepage, legal pages, owner account and
emails — so it must fit in the API function's time limit. A function killed
part-way leaves the event's claim unfinished; Stripe's next delivery takes it
over after 10 minutes — but one that lands sooner is answered "duplicate",
and Stripe stops. So:

**Stuck signups recover on their own** (`signupProvisioning.recoverSignup`).
A signup `provisioning` or `failed` whose last attempt began more than 15
minutes ago (`STUCK_MS`) is retried at most every 15 minutes
(`RETRY_EVERY_MS`, claimed atomically on `signup.recoveryAt`): the paid page
is read back from Stripe (`checkout.sessions.retrieve(signup.stripeSessionId)`)
and `completeSignupCheckout` runs on it, exactly as a webhook retry would.
Two things start a retry: the daily job (`jobs.recoverStuckSignups`, up to 3
a run, the answer's `signups: { recovered, failed, gave_up, results }`; with
`dryRun` only `due` is listed), and the success page's status poll (after
the answer, via `afterResponse`, for a buyer still watching). The signup
keeps `recoveryAttempts`, `recoveryStartedAt`, `recoveryAt`, `alertedAt`,
`gaveUpAt`. After 3 retries that did not set it up, the admins are emailed
once ("still not set up"). After 3 days of retries (Stripe's own retry
window, and how long the buyer is kept from paying again) it is **given
up on**: its Stripe subscription is cancelled at once (`invoice_now: false,
prorate: false` — nothing more is charged; on a trial nothing ever was), the
signup stays `failed` with `gaveUpAt` and an `error` saying so (and what to
refund, when the first invoice took money — refunds are by hand), and the
buyer and the admins are emailed. A given-up signup holds no web address,
does not block its buyer from signing up again, is ignored by a late
webhook delivery, and its status page says the subscription was cancelled.
If Stripe will not cancel, nothing is marked and the next run tries again.

## Owner lifecycle emails — `jobs.sendOwnerBillingNotices({ dryRun })`

Called by the cron after `rollSubscriptionStatuses`. For every active gym
with an owner email, once each (recorded in `subscription.notices`):
trial ending in 7, 3 and 1 days (`trial7 / trial3 / trial1`; when the cron
missed days only the most urgent goes out and the rest are marked), moved to
`past_due` (`pastDue`; a failed card is told the day it is cut off),
`expired` (`expired`; for a gym cut off with its period still ahead, "Ended"
is when it went past due), `cancelled` (`cancelled` — Stripe ended the
subscription; "Subscription ended" with the renew link — only while the
cancellation is under a week old: older ones are marked without an email,
so the first run does not write to every gym that ever left). Each email names the gym and the
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
