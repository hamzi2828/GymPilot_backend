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
