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
| `period` | label for one-off packages ("month", "3 months", "year"), and — with no `durationDays` — how long one term lasts (see below) |
| `durationDays` | explicit validity in days; 0 = derive from `period` |
| `billing.mode` | `one_time` (a term paid up front) or `recurring` (Stripe subscription) |
| `billing.interval` / `intervalCount` / `trialDays` | what Stripe bills on, for recurring |
| `sessions` | sessions on a pack (packs expire when used up or when `durationDays` passes) |
| `joiningFee` | charged once, on top of a member's first membership: not to anyone who has had a paid (or refunded) membership before, and never on a renewal or a package change (`membershipService.joiningFeeDue`) |

**How long a term lasts** (`membershipService.termEnd`): `durationDays` when
it is set; else the billing interval of a recurring package; else what the
`period` label names (`periodLength`). The label is read for the first unit
it names — day, week, fortnight (or bi-weekly), month, quarter, half year
(or semi-annual), year — with a count in front in digits or in words up to
twelve: "month", "3 months", "six weeks", "12 Months Membership",
"quarterly". A one-off package with no `durationDays` whose label names no
length ("Custom", "Lifetime"), or one that reads two ways ("bi-monthly",
"biannual"), is refused when it is saved: `400 { code:
'PERIOD_NOT_UNDERSTOOD', message }`, the message saying what to write, or to
set the days instead. Only a package already stored that way, saved with its
label untouched, is let through; it still sells as 30 days, as it always
did, until it is put right.

**Who has joined** (the joining fee, and a new term starting when the
current one ends) is decided by the account, never by an email typed into a
form. Online, that is the signed-in account (`membershipService.checkoutIdentity`):
**a guest always pays the joining fee**, whatever address they type, and
`GET /api/gymfolio/membership/joining-fee-due` answers for the caller's own
account only (`due: true` signed out). A guest's earlier orders count for an
account only through the account's own email, and only once that email is
confirmed (SECURITY_AND_DATA.md → *Email confirmation*): until then the
account is new. An order paid online starts after the terms of the account
it was bought under; a guest order starts when it is paid.

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
  terminal or a mobile wallet (JazzCash, Easypaisa, other). `POST
  /package-orders/assign` (package-orders · manage) `{ userId, packageId,
  paymentMethod?, markPaid?, couponCode?, durationMonths?, startDate? |
  startAfterDays?, discountAmount?, discountNote?, amountOverride? (or
  amount), waiveJoiningFee?, trainerId?, trainerFee?,
  trainerCommissionType? ('percent' | 'amount'), trainerCommissionValue?,
  notes?, requestId? }` → `201 { success, message, data: order }`
  (`requestId`: see *Sent twice* below). `startDate` (a bare
  `YYYY-MM-DD` is the start of that day at the gym) or `startAfterDays`
  (0–365: the start of that day from today; 0 = now) — not both — lets a
  member register today and start later; the end date is worked out from
  that start. Left out, a membership bought while another is live starts
  when that one ends. The discount comes off the package price; a trainer
  adds `trainerFee` to the total, records `trainerAssignment` (commission
  as a percentage of the fee, or a fixed amount; `commissionAmount` is what
  it comes to) and makes them the member's `assignedTrainerId`. Each field
  is checked by `membershipService.readDeskTerms`: a value that cannot be
  used is `400 INVALID_TERMS` naming it; an unknown trainer `404
  TRAINER_NOT_FOUND`, an inactive one `409 TRAINER_INACTIVE`.
  A new member can be registered and sold the membership in one request —
  `POST /api/admin/members/register { ...member, membership: { packageId,
  ...the terms above } }` (FEATURES.md → *Adding a member at the desk*):
  the same sale, and the account is removed again when the sale fails.

**Sent twice — `requestId`.** A desk request whose answer never arrived (a
timeout, a dropped connection) gets sent again, and used to sell a second
term or record the same money twice. Assign, renew, a part payment
(`POST /package-orders/:id/payments`) and Add member each take an optional
`requestId`: any id the screen makes up for that one action — 8 to 100
letters, digits, hyphens or underscores, a UUID will do; anything else is
`400 INVALID_TERMS` — sent again unchanged on a retry. A request whose id is
already recorded answers with the first result plus `repeated: true` and
changes nothing; a repeated sale or renewal sends no second confirmation
email. Without one every request is new, as before. Where it is kept: `metadata.requestId` on the order a
sale or renewal made (matched per member), `metadata.lastPaymentRequestId`
for an order's latest part payment, and `registrationRequestId` on the
account Add member made (unique per gym). Add member takes it at the top
level or as `membership.requestId`; its repeat answers `{ success, repeated:
true, message, member, order, credentials: null, emailed: false }` with no
`password` — that was shown or emailed once and only its hash is kept — and
a message saying to set one from the member's profile if it was missed.

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
* **Renew** — `POST /package-orders/:id/renew` (staff) `{ paymentMethod?,
  markPaid?, months?, notes?, force?, startDate?, discountAmount?,
  discountNote?, amountOverride?, amountPaid?, requestId? }`: a fresh term
  of the same package, starting when the current one ends (or on
  `startDate`), priced like a sale. Never a joining fee; no trainer (400).
* **Edit terms** — `PATCH /package-orders/:id/terms { startDate?, endDate?,
  discountAmount?, discountNote?, note? }` (package-orders · manage) → `{
  success, message, data: order }`. Moves the dates (a bare date is the
  start / the whole of that day at the gym; the end must follow the start;
  a lapsed membership extended into the future is live again, a live one
  ended in the past is expired) or sets the order's whole discount, off the
  package price only: the total moves by the difference, never below the
  fees it carries (400). Money received stays as it was — `amountPaid` is
  written down — and the balance follows; a discount that would take the
  total below what was paid is `409 REFUND_NEEDED`. The invoice keeps its
  number and takes the new total. Each change is appended to
  `termsHistory[] { at, by, from, to, note }` (`from` / `to`: `startDate,
  endDate, discountAmount, discountNote, amount, balanceDue`). Refused on a
  card subscription (`409 STRIPE_BILLED`: Stripe's billing sets its dates and
  price), on the price of any card payment, and on a closed order (`409
  ORDER_CLOSED`: refunded, failed or cancelled); `409 TERMS_CHANGED` when the
  order moved on while it was being saved.
* **Change package** — `POST /package-orders/:id/change-package {packageId,
  paymentMethod?, markPaid?, notes?, forfeitCredit?}` (staff): the unused
  days of the old package are credited pro rata against the new price -- the
  membership money received only: the admission fee and the trainer's fee
  inside the total were charged once and are not credited back. A credit
  worth more than the new package (a year paid, six months left, moved to a
  monthly) cannot all come off its price, and the rest would be money the
  member paid for nothing: the change is refused with `409 { code:
  'CREDIT_EXCEEDS_PRICE', details: { credit, price, creditUnused, currency } }`
  and a message saying to refund first — or to confirm. Sent again with
  `forfeitCredit: true` it goes ahead. The answer is `201 { success, message,
  data: new order, previous, credit, creditUnused }`: what came off the new
  price, and what was given up (0 when nothing was). On a Stripe subscription
  the subscription item is switched and Stripe prorates (`credit` and
  `creditUnused` are `null`); a subscription cannot be moved onto a package
  that is not billed by subscription (`409 NOT_A_SUBSCRIPTION_PACKAGE`).
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
staff from Package Orders. The admission fee and the personal trainer's fee
are lines of their own under the package.

## What an order's money is made of — `src/gymfolio/services/orderMoney.js`

`payment.amount` is the whole order. Inside it, every order written records
`payment.joiningFee` (the admission fee charged on *this* order: 0 on a
renewal, a package change, or when waived) and `payment.trainerFee` (the
personal trainer's fee); the membership is the rest, `amount − joiningFee −
trainerFee`, never below 0. A discount comes off the package price only;
an amount override, or a payment covering part of the order, is allocated
to admission first, then the trainer's fee, then the membership
(`orderMoney.allocate`).

`ledger.membershipPaymentStages` — what the accounts, dashboard, reports and
the platform's gym stats all read membership money through — gives every
payment row `admission`, `trainerFee` and `membership` beside `amount`,
the payment's own `method`, and `kind` (`initial`, `installment` for later
parts of an order paid in parts, `renewal` — which carries neither fee).
`kind: 'renewal'` is Stripe charging one order again; a desk renewal or a
package change is a new order whose first payment is `initial`, and the row's
`renewedFrom` (the order it renewed or replaced; `null` for none) is what
tells it apart — Daily sales files those under renewals.

**Imported memberships are not takings.** A membership the member import
brings in already paid is marked `imported: true` on the order: the money
was taken in the gym's old system, before it moved here. The membership is
whole — dates, the desk, bookings — but its first payment is left out of
`membershipPaymentStages`, and so out of the dashboard, Accounts (overview
and sales), Daily sales, the P&L, the reports and the platform's gym stats;
importing 300 members does not put 300 payments into today's revenue. It is
given no invoice number (`GET /package-orders/:id/invoice.pdf` answers `404
NO_INVOICE` for it), and the orders export has an **Imported** column.
Money taken on it later — a balance paid off after its terms are edited —
counts on the day it arrives, and a row imported as not paid is an ordinary
pending order, whose payment and invoice are today's when it is paid.

### Paying in parts

A membership sold at the desk may be paid for over time. `amountPaid` on
assign or renew (less than the total; 0 = nothing yet) grants it at once —
`payment.status` is `paid` and the order `active`, so everything that treats
paid as live keeps working — with `payment.amountPaid` (money received so
far; `null` on older orders, which were paid in full) and
`payment.balanceDue`. `amountPaid` above the total, or on an order left
pending, is a 400. Every order paid from now on records `amountPaid` (the
whole amount when paid in full).

`payment.installments[]` — `{ amount, joiningFee, trainerFee, method, at,
by, note }` — are, when there are any, the money received for the order, the
first payment included; each is allocated admission first, then trainer's
fee, then membership. An order paid in full at once keeps none.

| Route | Permission | Answer |
|---|---|---|
| `POST /package-orders/:id/payments { amount, method?, note?, requestId? }` | package-orders · manage | `{ success, message, data: order }` (`repeated: true` when the same `requestId` was already recorded — see *Sent twice*) — money received against the balance, recorded as an installment (the fees still owed first; `method` defaults to the order's). An order paid in part at once gets that first payment as its opening installment. Refused: `400 INVALID_PAYMENT` (not above 0), `400 OVERPAYMENT` (more than the balance), `422 PAYMENT_METHOD_INVALID`, `409 STRIPE_BILLED` (the order goes through Stripe), `409 NOT_PAID` (pending or refunded), `409 NO_BALANCE`, `409 REFUND_IN_PROGRESS` (a refund of the order is under way: it gives back what had come in when it started and clears the balance, so a payment taken meanwhile would be neither refunded nor owed), `409 BALANCE_CHANGED` (somebody recorded a payment at the same moment: one conditional write on the balance it started from). |
| `GET /package-orders/dues?search=&page=&limit=` | package-orders · view | `{ success, data: [{ memberId, name, phone, email, gender, memberCode, currency, balanceDue, orders: [{ orderId, orderNumber, packageName, status, amount, amountPaid, balanceDue, startDate, endDate, lastPaidAt }] }], totals: [{ currency, balanceDue, members, orders }], pagination: { page, limit, total, pages } }` — one row per member and currency with money still owed on a granted order, largest balance first; `limit` at most 200 (default 50). Member fields come from the member's record, else the order's own copy (a guest). |
| `GET /package-orders?hasDues=1` | package-orders · view | the orders list, only those with a balance due |

A refund gives back at most what came in (`amountPaid`) and clears the
balance; an order with nothing paid yet is cancelled, not refunded. Changing
package is refused while money is owed (`409 BALANCE_DUE`): the credit for
unused days would be worked out on money that never came in. The invoice
shows the total, what was paid so far and the balance due, and lists the
payments received.

Orders from before `payment.joiningFee` existed read 0. Where their total
did include the fee (subtotal = price + fee), fill it in per gym:

    node scripts/backfillOrderFees.js --gym <slug>           # report only
    node scripts/backfillOrderFees.js --gym <slug> --apply   # write it

An old order saved since (frozen, cancelled, updated by a Stripe webhook)
has the schema's default `0` in the field rather than no field, and is found
too: one with no trainer's fee and no trainer (trainers were first sold
after the split, and every order written since records the fee it charged).
`--before YYYY-MM-DD` — the day the server started recording the fee —
limits those to orders created before it (`scripts/lib/orderFees.js`).

## Member lists for the desk — `src/gymfolio/services/membershipLists.js`

One row per **member**, not per order, for the desk's screens to be built
on. "Membership" means a package of kind `membership` (orders from before
kinds read as memberships); packs, passes and trials are not what runs out
and gets renewed. All are package-orders · view, and sweep lapsed orders
first (throttled), like the orders list.

Every list row carries the member — `memberId` (null for a guest order),
`name`, `phone`, `email`, `gender`, `memberCode` (from the member's record,
read-only; else the order's own copy) — and the membership it is about:
`orderId`, `orderNumber`, `packageName`, `status`, `paymentStatus`,
`startDate`, `endDate`, `amount`, `balanceDue`, `currency`. Lists answer
`{ success, data: [row], pagination: { page, limit, total, pages } }`
(`limit` at most 200, default 50) and take `search` (order number, name,
email or phone).

| Route | Answer |
|---|---|
| `GET /package-orders/expiring?days=7&includeAutoRenew=0` | Members whose membership ends within `days` (1–365, default 7; else `400 INVALID_QUERY`) and who have not renewed: each member's live membership (paid; active, frozen or past due) that runs **latest** must end inside the window, so a paid renewal running past it takes the member off the list — an unpaid one does not. Rows add `daysLeft` (whole days at the gym; 0 = ends today) and `autoRenews`; card subscriptions Stripe renews by itself are left out unless `includeAutoRenew=1`. Soonest first; the answer also says `days`. |
| `GET /package-orders/expired?withinDays=` | Members whose latest membership — the one ending last among those not cancelled or refunded: paid, paid in part, **or never paid** (assigned pending) — has ended, and no paid membership of theirs runs past it (a renewal waiting to be paid does not count). `withinDays` (1–3650) keeps those that ended in the last so many days. Rows add `daysOverdue`. Most recently lapsed first. |
| `POST /package-orders/summary { userIds: [...] }` | At most 500 member ids (`400 INVALID_QUERY` for more, none, or one that is not an id). `{ success, data: [{ userId, membership }] }` in the order asked, each member once: their current membership (paid, live and running today; the one ending last if several), else their latest (ending last, whatever became of it), else `null`. `membership`: `{ orderId, orderNumber, packageName, status, paymentStatus, method, current, startDate, endDate, daysLeft, amount, discountAmount, joiningFee, trainerFee, amountPaid (money received; the whole amount on older paid orders), balanceDue, currency, trainerName }`. A read sent as a POST because 500 ids do not fit in an address. |
| `GET /package-orders/dues` | see *Paying in parts* above |
| `GET /package-orders/desk/members?q=&limit=` | The fee desk's member search (`services/feeDesk.js`): members only (role `user`), disabled accounts included and flagged `isActive: false`. Every word must match a name, the email, the phone or the member ID; a term that looks like a phone also matches by its digits ("0300 1234567" finds "0300-1234567"); a member ID typed in full, or as its bare number ("184" is GP-0184, not GP-1840), comes first. `limit` default 8, at most 25; an empty `q` finds nobody. `{ success, data: [{ id, name, memberCode, phone, email, gender, avatarUrl, isActive, membership }], hasMore }` — `membership` as in the summary. |
| `GET /package-orders/desk/members/:userId` | One member at the desk: `{ member, membership, running, package, dues, joiningFeeDue, currency }`. `membership` is the one a renewal follows — of their paid, live memberships the one that runs **latest** (a term paid in advance included), else the one that ended last whatever became of it, else `null` — with the summary's money fields plus `packageId`, `discountNote`, `live`, `startsLater` (paid in advance, not begun), `daysLeft` (negative once ended), `autoRenews`, `stripeBilled`, `cardPaymentFailed`. Renew **that** order: renewing the one running today again would sell a second term over the one already paid for. `running` is the membership running today when it is not `membership`. `package`: `{ id, name, price, currency, period, kind, isActive }` as sold now — what a renewal costs — or `null` once deleted. `dues`: every granted order owing money, oldest term first (`orderId, orderNumber, packageName, status, method, amount, amountPaid, balanceDue, currency, startDate, endDate, stripeBilled`). `404 MEMBER_NOT_FOUND`. |

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

## Suspending and deleting a gym

**Suspend pauses collection.** `PATCH /api/platform/gyms/:id/status { status:
'active' | 'suspended' }`: a suspended gym that pays by card is not charged
while it is off — Stripe stops collecting on its subscription
(`pause_collection`, each invoice that falls due voided, nothing owed for
the time paused) and starts again when the gym is reactivated. The switch
itself never waits on Stripe: when Stripe refuses, the status still changes
and the answer's `warnings` say what to pause or resume by hand. `billing`
is `{ subscriptionId, paused }` when Stripe took it.

**Deleting a gym cancels its platform subscription.** `DELETE
/api/platform/gyms/:id { confirmSlug, dropDatabase?, subscriptionCancelled?,
memberSubscriptionsAcknowledged? }` cancels the gym's Stripe subscription
with the platform at once, with nothing more invoiced, before anything is
removed (and closes a payment page its Billing tab left open). When Stripe
will not cancel it nothing is deleted: `409 { code:
'SUBSCRIPTION_NOT_CANCELLED', details: { subscriptionId } }` — cancel it in
the Stripe dashboard, then delete again with `subscriptionCancelled: true`.
A gym whose members still pay it by card subscription is refused too (`409
{ code: 'MEMBER_SUBSCRIPTIONS_ACTIVE', details: { count } }`) until
`memberSubscriptionsAcknowledged: true`: those are in the gym's own Stripe
account, not the platform's to cancel, and go on charging.

## Paying outside Stripe — `src/platform/services/manualPayments.js`

A gym that pays the platform by bank transfer, JazzCash, Easypaisa or cash
has each payment recorded by hand from the platform panel:

| Route (super admin) | Answer |
|---|---|
| `GET /api/platform/gyms/:id/payments` | `{ success, data: [payment], next }` — the payments recorded for the gym, newest first, and `next`: whether another can be recorded (`canRecord`, with the `reason` when not) and what the form starts from — `amount`, `currency`, `billingCycle`, `paidFrom`, `paidUntil`, `methods`. |
| `POST /api/platform/gyms/:id/payments { amount, method, receivedAt?, reference?, note?, paidUntil?, requestId }` | `201 { success, data: payment, duplicate: false, gym, warnings }`. `method` is `bank_transfer`, `jazzcash`, `easypaisa`, `cash` or `other`; the first three need a `reference` (the transaction id). The payment is kept in the gym's history, its paid-until date (`subscription.currentPeriodEnd`) moves to `paidUntil` — by default one billing cycle on from the later of today and the date already paid until — and the subscription becomes `active` whatever it was, so a gym cut off for not paying is served again at once. The form's `requestId` (at least 8 characters) makes a second click the same payment: `200` with `duplicate: true` and nothing moved. Refused: `400 INVALID_PAYMENT` (the first problem found, in words), `409 DUPLICATE_REFERENCE` (that reference is already on record for the gym), `409 STRIPE_BILLED` (the gym pays by card; Stripe records its payments and moves its dates itself). A suspended gym stays suspended, and `warnings` says so. |

The daily roll-over needs nothing more: a gym with no Stripe subscription
goes past due when `currentPeriodEnd` passes, and this is what moves it.

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
`helper/money.toMinorUnits` — zero-decimal currencies as they are, and the
three-decimal ones (BHD, JOD, KWD, OMR, TND) in thousandths, rounded to the
hundredth as Stripe requires; what Stripe reports is read back the same way
with `fromMinorUnits`, so a dinar is not read as ten) from the
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
* `PLATFORM_ADMIN_ORIGIN` is set — Stripe sends the buyer back to it, and in
  production nothing stands in for it (only a developer's machine falls back
  to `http://localhost:3001`);
* a webhook signing secret is saved there too, or no payment could ever
  create its gym;
* `SMTP_HOST`, `SMTP_USER` and `SMTP_PASS` are all set **and the mail server
  accepts them** — a gym made a moment ago has no email settings of its own,
  so its owner's set-password link goes out through the env SMTP, and
  without it the buyer would pay and never get into their gym. Filled in is
  not enough (a wrong password is filled in too), so the server is asked for
  a connection and a login (`platformEmail.verifyPlatformEmail`, the answer
  remembered for a couple of minutes). Asked last: it is the one check that
  leaves the building.

Stripe sends the buyer back to `<origin>/checkout/success?signup=<id>`, or
`<origin>/checkout?plan=…&cycle=…&cancelled=1` — the request's own `Origin`
when it is one of the origins `PLATFORM_ADMIN_ORIGIN` lists, else the first
one listed. The platform webhook must be registered with
`checkout.session.completed` (DEPLOYMENT.md §2).

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
