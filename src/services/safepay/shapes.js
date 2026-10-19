// src/services/safepay/shapes.js
//
// What Safepay's answers mean, as pure functions: amounts, tracker states,
// the saved card a tracker or wallet describes, and the webhook signature.
// No network and no database, so all of it is unit-tested directly.
//
// Sources (October 2026):
//   amounts       https://safepay-docs.netlify.app/concepts/money
//                 -- "the lowest denomination (or minor units)": paisa for PKR
//   states        https://safepay-docs.netlify.app/concepts/tracker-states
//   webhooks      https://safepay-docs.netlify.app/developers/webhooks/verify-hmac-signatures
//                 -- X-SFPY-SIGNATURE, HMAC-SHA512 (hex) with the endpoint's
//                 shared secret; the official PHP library (getsafepay/sfpy-php,
//                 WebhookSignature.php) signs the raw request body, the older
//                 Node SDK (getsafepay/safepay-node, verify.ts) the JSON of
//                 its `data`.

const crypto = require('crypto');
const { toMinorUnits, fromMinorUnits, normaliseCurrency } = require('../../helper/money');

class SafepayError extends Error {
  /**
   * @param {string} message  safe to show the person who asked
   * @param {string} code     e.g. SAFEPAY_NOT_CONFIGURED
   * @param {number} status   the HTTP status to answer our own caller with
   * @param {object} [extra]  { safepayStatus, detail }
   */
  constructor(message, code = 'SAFEPAY_ERROR', status = 502, extra = {}) {
    super(message);
    this.name = 'SafepayError';
    this.code = code;
    this.status = status;
    if (extra.safepayStatus !== undefined) this.safepayStatus = extra.safepayStatus;
    if (extra.detail !== undefined) this.detail = extra.detail;
  }
}

// The currencies Safepay takes payments in (docs: Money). All of them have
// a hundred minor units.
const SUPPORTED_CURRENCIES = ['PKR', 'USD', 'GBP', 'EUR', 'CAD', 'AED', 'SAR'];

function currencyCode(currency) {
  return normaliseCurrency(currency) || '';
}

/**
 * Major units (rupees) -> what Safepay is sent: an integer in minor units
 * (paisa). Throws for a currency Safepay does not take or an amount that is
 * not above zero: neither is a payment to start.
 */
function toSafepayAmount(amount, currency) {
  const code = currencyCode(currency);
  if (!SUPPORTED_CURRENCIES.includes(code)) {
    throw new SafepayError(
      `Online payments through Safepay are in ${SUPPORTED_CURRENCIES.join(', ')}; this gym sells in ${code || 'an unknown currency'}.`,
      'SAFEPAY_CURRENCY_UNSUPPORTED',
      409
    );
  }
  const value = Number(amount);
  const minor = Number.isFinite(value) ? toMinorUnits(value, code) : NaN;
  if (!Number.isInteger(minor) || minor <= 0) {
    throw new SafepayError('There is nothing to pay online for this order.', 'NOTHING_TO_PAY', 400);
  }
  return minor;
}

/** What Safepay reports (minor units) -> major units, two decimals. null when absent. */
function fromSafepayAmount(minor, currency) {
  if (minor === undefined || minor === null || minor === '') return null;
  const value = Number(minor);
  if (!Number.isFinite(value)) return null;
  return fromMinorUnits(value, currencyCode(currency) || 'PKR');
}

// Tracker states (docs: Tracker states) and what each means for an order.
//
//   paid     the money was taken: TRACKER_ENDED. A tracker since partly
//            refunded or disputed was still paid -- the gym decides about
//            the refund or dispute, the payment happened. 'PAID' is the
//            older (v1) notification's word for the same thing.
//   failed   no money is kept: the shopper cancelled, the session expired,
//            or the payment was refunded in full, voided or reversed.
//   pending  anything else: started, 3-D Secure under way, authorized but
//            not captured yet, or a state added after this was written.
const PAID_STATES = new Set(['TRACKER_ENDED', 'TRACKER_PARTIAL_REFUND', 'TRACKER_DISPUTED', 'PAID']);
const FAILED_STATES = new Set(['TRACKER_CANCELLED', 'TRACKER_EXPIRED', 'TRACKER_REFUNDED', 'TRACKER_VOIDED', 'TRACKER_REVERSED']);

/** @returns {'paid'|'failed'|'pending'} */
function mapTrackerState(state) {
  const value = String(state || '').trim().toUpperCase();
  if (PAID_STATES.has(value)) return 'paid';
  if (FAILED_STATES.has(value)) return 'failed';
  return 'pending';
}

/**
 * The tracker inside a reporter or order response, whichever shape it came
 * in: `data.tracker` (Express Checkout guide, order API) or `data` itself
 * (Fetch Tracker guide).
 */
function trackerOf(body) {
  const data = body && typeof body === 'object' ? body.data || body : null;
  if (!data || typeof data !== 'object') return null;
  if (data.tracker && typeof data.tracker === 'object') return data.tracker;
  return data;
}

// Cybersource card scheme numbers as Safepay's wallet reports them (its
// example: scheme 2 for a 520000 Mastercard BIN), else the scheme's name.
const SCHEMES = { 1: 'Visa', 2: 'Mastercard', 3: 'American Express', 4: 'Discover', 5: 'Diners Club', 7: 'JCB', '001': 'Visa', '002': 'Mastercard', '003': 'American Express' };

function brandOf({ scheme, cardType, bin } = {}) {
  const named = [cardType, scheme].find((value) => typeof value === 'string' && value.trim() && !/^\d+$/.test(value.trim()));
  if (named) {
    const text = named.trim();
    if (/master/i.test(text)) return 'Mastercard';
    if (/visa/i.test(text)) return 'Visa';
    if (/amex|american/i.test(text)) return 'American Express';
    if (/paypak/i.test(text)) return 'PayPak';
    if (/union/i.test(text)) return 'UnionPay';
    return text.slice(0, 30);
  }
  const code = [scheme, cardType].find((value) => value !== undefined && value !== null && SCHEMES[String(value).trim()] !== undefined);
  if (code !== undefined) return SCHEMES[String(code).trim()];
  const digits = String(bin || '');
  if (/^4/.test(digits)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'Mastercard';
  if (/^3[47]/.test(digits)) return 'American Express';
  return 'Card';
}

function cleanMonth(value) {
  const month = parseInt(String(value || ''), 10);
  return month >= 1 && month <= 12 ? month : null;
}

function cleanYear(value) {
  let year = parseInt(String(value || ''), 10);
  if (!Number.isFinite(year)) return null;
  if (year < 100) year += 2000;
  return year >= 2000 && year <= 2100 ? year : null;
}

function cleanLast4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

/**
 * A saved card as one entry of a customer's Safepay wallet describes it
 * (docs: Manage tokens): its payment-method token and what may be shown.
 * Never the card number -- Safepay does not send it, and nothing here would
 * keep it.
 *
 * @returns {{ token, brand, last4, expMonth, expYear, createdAt }|null}
 */
function walletCard(entry) {
  if (!entry || typeof entry !== 'object' || !entry.token || entry.is_deleted) return null;
  const card = entry.cybersource || entry.card || entry.payment_method || {};
  const seconds = entry.created_at && Number(entry.created_at.seconds);
  return {
    token: String(entry.token),
    brand: brandOf({ scheme: card.scheme, cardType: card.card_type, bin: card.bin || card.bin_number }),
    last4: cleanLast4(card.last_four),
    expMonth: cleanMonth(card.expiry_month || card.expiration_month),
    expYear: cleanYear(card.expiry_year || card.expiration_year),
    createdAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null
  };
}

/** The wallet entries in a list-wallet answer, whichever key holds them. */
function walletEntries(body) {
  const data = body && typeof body === 'object' ? body.data || body : null;
  if (!data) return [];
  const list = Array.isArray(data) ? data : Array.isArray(data.wallet) ? data.wallet : Array.isArray(data.payment_methods) ? data.payment_methods : [];
  return list.map(walletCard).filter(Boolean);
}

/** The card a tracker was paid with (fetch tracker's action or last attempt), for display. */
function trackerCard(body) {
  const data = body && typeof body === 'object' ? body.data || body : {};
  const tracker = trackerOf(body) || {};
  const attempts = Array.isArray(data.attempts) ? data.attempts : Array.isArray(tracker.attempts) ? tracker.attempts : [];
  const fromAttempt = attempts.length ? attempts[attempts.length - 1].payment_method : null;
  const method = (data.action && data.action.payment_method) || fromAttempt || null;
  if (!method) return null;
  return {
    brand: brandOf({ scheme: method.scheme, cardType: method.card_type, bin: method.bin || method.bin_number }),
    last4: cleanLast4(method.last_four),
    expMonth: cleanMonth(method.expiration_month || method.expiry_month),
    expYear: cleanYear(method.expiration_year || method.expiry_year)
  };
}

/** The amount, fee and net a reporter answer gives for a tracker, in minor units (null when absent). */
function trackerMoney(body) {
  const data = body && typeof body === 'object' ? body.data || body : {};
  const tracker = trackerOf(body) || {};
  const totals = tracker.purchase_totals || data.purchase_totals || {};
  const quote = totals.quote_amount || totals.base_amount || {};
  const charge = data.charge || tracker.charge || {};
  const pick = (value) => (value && value.amount !== undefined ? Number(value.amount) : null);
  return {
    amountMinor: pick(charge.amount) ?? (quote.amount !== undefined ? Number(quote.amount) : null),
    currency: String((charge.amount && charge.amount.currency) || quote.currency || '').toUpperCase() || null,
    feeMinor: pick(charge.fees),
    netMinor: pick(charge.net)
  };
}

/* ------------------------------ webhooks ------------------------------- */

function headerValue(headers, name) {
  if (!headers) return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return Array.isArray(value) ? String(value[0] || '') : String(value || '');
  }
  return '';
}

function hmacHex(secret, data) {
  return crypto.createHmac('sha512', secret).update(data).digest('hex');
}

function sameHex(a, b) {
  const left = Buffer.from(String(a).trim().toLowerCase(), 'utf8');
  const right = Buffer.from(String(b).trim().toLowerCase(), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Checks a webhook delivery and returns the event it carries.
 *
 * The signature (X-SFPY-SIGNATURE) is HMAC-SHA512, hex, keyed with the
 * endpoint's shared secret. What exactly is signed differs between
 * Safepay's own libraries -- the raw body (PHP library), or the JSON of the
 * whole event or of its `data` (Node SDK) -- so each of those is computed
 * and any one matching is accepted. Every candidate needs the secret: none
 * of them lets anyone without it through.
 *
 * @param {Buffer|string} rawBody  the request body exactly as received
 * @param {object} headers         the request headers
 * @param {string} secret          the gym's webhook shared secret
 * @returns {object} the parsed event ({ token, type, data, ... })
 * @throws {SafepayError} 400 SAFEPAY_SIGNATURE_INVALID / SAFEPAY_PAYLOAD_INVALID;
 *   409 SAFEPAY_WEBHOOK_NOT_CONFIGURED when there is no secret to check with
 */
function verifyWebhook(rawBody, headers, secret) {
  if (!secret) {
    throw new SafepayError('This gym has no Safepay webhook secret saved, so the event cannot be checked.', 'SAFEPAY_WEBHOOK_NOT_CONFIGURED', 409);
  }
  const signature = headerValue(headers, 'x-sfpy-signature');
  if (!signature) throw new SafepayError('The event carries no X-SFPY-SIGNATURE header.', 'SAFEPAY_SIGNATURE_INVALID', 400);

  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(typeof rawBody === 'string' ? rawBody : '', 'utf8');
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new SafepayError('The event is not JSON.', 'SAFEPAY_PAYLOAD_INVALID', 400);
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new SafepayError('The event is not a JSON object.', 'SAFEPAY_PAYLOAD_INVALID', 400);
  }

  const candidates = [raw, Buffer.from(JSON.stringify(event), 'utf8')];
  if (event.data !== undefined) candidates.push(Buffer.from(JSON.stringify(event.data), 'utf8'));
  const valid = candidates.some((data) => sameHex(hmacHex(secret, data), signature));
  if (!valid) throw new SafepayError('The event signature does not match this gym’s Safepay webhook secret.', 'SAFEPAY_SIGNATURE_INVALID', 400);
  return event;
}

/**
 * What a verified event says, in one shape: the tracker, what happened
 * ('paid' | 'failed' | 'refunded' | 'other'), and the money in minor units.
 * Knows the 2.0.0 events (docs: Webhook structure and types) and the older
 * notification shape; anything else is 'other' and is checked with Safepay.
 */
function readEvent(event) {
  const type = String((event && event.type) || '').trim();
  const data = (event && typeof event.data === 'object' && event.data) || {};
  const legacy = data.notification && typeof data.notification === 'object' ? data.notification : null;
  const body = legacy || data;
  const tracker = typeof body.tracker === 'string' ? body.tracker : typeof body.tracker === 'object' && body.tracker ? body.tracker.token : null;
  const metadata = (body.metadata && typeof body.metadata === 'object' && body.metadata) || {};
  const orderRef = typeof metadata.order_id === 'string' ? metadata.order_id : metadata.order_id && metadata.order_id.value ? String(metadata.order_id.value) : null;

  let outcome = 'other';
  // A success whose state says otherwise is not taken on its word: it is
  // confirmed with Safepay like an event of a kind not known here.
  if (type === 'payment.succeeded') outcome = mapTrackerState(body.state || 'TRACKER_ENDED') === 'paid' ? 'paid' : 'other';
  else if (type === 'payment.failed') outcome = 'failed';
  else if (type === 'payment.refunded' || type === 'void.succeeded' || type === 'authorization.reversed') outcome = 'refunded';

  return {
    id: event && typeof event.token === 'string' ? event.token : null,
    type,
    tracker,
    orderRef,
    outcome,
    state: body.state || null,
    // Legacy notifications are excluded from the money: their units were
    // never documented. Those events are confirmed with Safepay instead.
    amountMinor: legacy ? null : body.amount !== undefined ? Number(body.amount) : null,
    currency: legacy ? null : body.currency ? String(body.currency).toUpperCase() : null,
    feeMinor: legacy ? null : body.fee !== undefined ? Number(body.fee) : null,
    netMinor: legacy ? null : body.net !== undefined ? Number(body.net) : null,
    message: typeof body.message === 'string' ? body.message.slice(0, 300) : '',
    legacy: !!legacy
  };
}

module.exports = {
  SafepayError,
  SUPPORTED_CURRENCIES,
  toSafepayAmount,
  fromSafepayAmount,
  mapTrackerState,
  trackerOf,
  trackerMoney,
  trackerCard,
  walletCard,
  walletEntries,
  brandOf,
  verifyWebhook,
  readEvent,
  headerValue
};
