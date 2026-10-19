// src/services/safepay/api.js
//
// Safepay's HTTP API, called directly with Node's fetch (no SDK: the
// official ones pull in axios and, in node-core's case, ESM builds that the
// Vercel runtime cannot require).
//
// Every call is made for ONE gym, with the keys passed in (config.js reads
// them from that gym's Settings); nothing here knows about tenants.
//
// Endpoints, from Safepay's docs and its own libraries (October 2026):
//
//   POST /order/payments/v3/                 create a tracker (payment session)
//        Express Checkout guide; getsafepay/sfpy-php OrderService::setup
//   POST /order/payments/v3/{tracker}        run the tracker's next action
//        (charge a saved card) -- sfpy-php examples/customers-payment-ucof.php
//   POST /order/payments/v3/{tracker}/metadata   attach our order reference
//   POST /client/passport/v1/token           short-lived token for Checkout
//   POST /user/customers/v1/                 create a customer (card saving)
//   GET  /user/customers/v1/{cus}/wallet/    the customer's saved cards
//   GET  /reporter/api/v1/payments/{tracker} a tracker's state (Fetch Tracker
//        guide; the PHP library reads /reporter/api/v2/, tried when v1 is 404)
//
// Authentication for server-to-server calls: the merchant secret key in the
// X-SFPY-MERCHANT-SECRET header (Express Checkout guide, "Before you begin").
//
// Hosted checkout: <checkout host>/embedded/?environment=&tracker=&tbt=&source=
// &redirect_url=&cancel_url=[&user_id=&is_implicit=true] (getsafepay/node-core
// Checkout.ts, sfpy-php Checkout::constructURL).

const { SafepayError } = require('./shapes');

const ENVIRONMENTS = {
  sandbox: { api: 'https://sandbox.api.getsafepay.com', checkout: 'https://sandbox.api.getsafepay.com' },
  production: { api: 'https://api.getsafepay.com', checkout: 'https://getsafepay.com' }
};

const REQUEST_TIMEOUT_MS = 20000;

// The payment channel for cards. Wallets and bank apps are offered on the
// same hosted page as the gym's Safepay account allows.
const INTENT = 'CYBERSOURCE';
const SOURCE = 'gymspilotpro';

/**
 * The hosts for an environment. Outside production a test may point both at
 * a local stand-in (SAFEPAY_API_BASE_URL / SAFEPAY_CHECKOUT_BASE_URL); in
 * production they are always Safepay's own, so no setting can send a gym's
 * secret key anywhere else.
 */
function hostsFor(environment, env = process.env) {
  const hosts = ENVIRONMENTS[environment === 'production' ? 'production' : 'sandbox'];
  if (env.NODE_ENV === 'production') return { ...hosts };
  const trim = (value) => String(value || '').trim().replace(/\/+$/, '');
  return {
    api: trim(env.SAFEPAY_API_BASE_URL) || hosts.api,
    checkout: trim(env.SAFEPAY_CHECKOUT_BASE_URL) || trim(env.SAFEPAY_API_BASE_URL) || hosts.checkout
  };
}

// Safepay's sentence for a refused request, when it gave one.
function problemOf(body) {
  if (!body || typeof body !== 'object') return '';
  const status = body.status && typeof body.status === 'object' ? body.status : null;
  const errors = status && Array.isArray(status.errors) ? status.errors : Array.isArray(body.errors) ? body.errors : [];
  const first = errors.find((e) => typeof e === 'string' && e.trim()) || errors.map((e) => e && (e.message || e.detail)).find(Boolean);
  const text = first || (typeof body.message === 'string' && body.message) || (typeof body.error === 'string' && body.error) || (body.error && body.error.message) || '';
  return String(text).trim().slice(0, 300);
}

/**
 * One request to Safepay. Resolves the parsed JSON body; throws SafepayError
 * (502 SAFEPAY_UNREACHABLE when Safepay could not be reached or answered
 * nonsense, 502 SAFEPAY_REFUSED with Safepay's status and sentence when it
 * said no, 502 SAFEPAY_AUTH_FAILED for a 401/403).
 */
async function request(config, method, path, body) {
  const { api } = hostsFor(config.environment);
  const headers = { Accept: 'application/json', 'X-SFPY-MERCHANT-SECRET': config.secretKey };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(api + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error'
    });
  } catch (error) {
    throw new SafepayError('Safepay could not be reached. Please try again in a moment.', 'SAFEPAY_UNREACHABLE', 502, { detail: error && error.message });
  }

  const text = await response.text().catch(() => '');
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const said = problemOf(json);
    if (response.status === 401 || response.status === 403) {
      throw new SafepayError(said ? `Safepay refused the keys: ${said}` : 'Safepay refused the keys. Check the secret key and the environment.', 'SAFEPAY_AUTH_FAILED', 502, { safepayStatus: response.status });
    }
    throw new SafepayError(said ? `Safepay said: ${said}` : `Safepay answered ${response.status}.`, 'SAFEPAY_REFUSED', 502, { safepayStatus: response.status });
  }
  if (json === null) throw new SafepayError('Safepay sent an answer that could not be read.', 'SAFEPAY_UNREACHABLE', 502, { safepayStatus: response.status });
  return json;
}

/** POST /order/payments/v3/ -> the tracker token. `amount` in minor units. */
async function createTracker(config, { amount, currency, mode = 'payment', customer = null, orderRef = '' }) {
  const body = {
    merchant_api_key: config.publicKey,
    intent: INTENT,
    mode,
    currency,
    amount,
    metadata: orderRef ? { order_id: String(orderRef), source: SOURCE } : { source: SOURCE },
    include_fees: false
  };
  if (customer) body.user = customer;
  const json = await request(config, 'POST', '/order/payments/v3/', body);
  const tracker = json && json.data && json.data.tracker;
  const token = tracker && typeof tracker.token === 'string' ? tracker.token : null;
  if (!token) throw new SafepayError('Safepay did not return a payment session.', 'SAFEPAY_UNREACHABLE', 502);
  return { token, tracker };
}

/** POST /order/payments/v3/{tracker}/metadata -- our order reference, for Safepay's dashboard. */
async function addMetadata(config, tracker, orderRef) {
  return request(config, 'POST', `/order/payments/v3/${encodeURIComponent(tracker)}/metadata`, {
    data: { source: SOURCE, order_id: String(orderRef) }
  });
}

/** POST /client/passport/v1/token -> the time-based token Checkout opens with. */
async function createPassport(config) {
  const json = await request(config, 'POST', '/client/passport/v1/token', {});
  const data = json && json.data;
  const token = typeof data === 'string' ? data : data && typeof data.token === 'string' ? data.token : null;
  if (!token) throw new SafepayError('Safepay did not return a checkout token.', 'SAFEPAY_UNREACHABLE', 502);
  return token;
}

/** POST /user/customers/v1/ -> the customer token cards are saved under. */
async function createCustomer(config, { firstName, lastName, email, phone, country }) {
  const body = {
    first_name: firstName || 'Member',
    last_name: lastName || '-',
    email: email || undefined,
    phone_number: phone || undefined,
    country: country || 'PK',
    is_guest: false
  };
  const json = await request(config, 'POST', '/user/customers/v1/', body);
  const token = json && json.data && typeof json.data.token === 'string' ? json.data.token : null;
  if (!token) throw new SafepayError('Safepay did not return a customer.', 'SAFEPAY_UNREACHABLE', 502);
  return token;
}

/** GET /user/customers/v1/{customer}/wallet/ -- the raw answer (shapes.walletEntries reads it). */
async function listWallet(config, customer) {
  return request(config, 'GET', `/user/customers/v1/${encodeURIComponent(customer)}/wallet/?limit=20&page=0`);
}

/** DELETE /user/customers/v1/{customer}/wallet/{paymentMethod} (docs: Manage tokens). */
async function deleteWalletMethod(config, customer, paymentMethod) {
  return request(config, 'DELETE', `/user/customers/v1/${encodeURIComponent(customer)}/wallet/${encodeURIComponent(paymentMethod)}`);
}

/** POST /order/payments/v3/{tracker} -- runs the next action with `payload` (or {}). */
async function runAction(config, tracker, payload) {
  return request(config, 'POST', `/order/payments/v3/${encodeURIComponent(tracker)}`, payload === undefined ? {} : payload);
}

/** GET the reporter's view of a tracker (v1, else v2). */
async function fetchTracker(config, tracker) {
  const id = encodeURIComponent(tracker);
  try {
    return await request(config, 'GET', `/reporter/api/v1/payments/${id}`);
  } catch (error) {
    if (error && error.safepayStatus === 404) return request(config, 'GET', `/reporter/api/v2/payments/${id}`);
    throw error;
  }
}

/**
 * The hosted Checkout address for a tracker.
 *
 * `customer` (with `saveCard`) opens it for that Safepay customer and, with
 * is_implicit, saves the card used without a second checkbox -- the member
 * has already agreed to it on our checkout page (sfpy-php Checkout: "Instead
 * of a checkbox ... the customer is shown a disclaimer saying that their card
 * will be saved").
 */
function checkoutUrl(config, { tracker, tbt, redirectUrl, cancelUrl, orderRef, customer = null, saveCard = false }) {
  const { checkout } = hostsFor(config.environment);
  const params = new URLSearchParams({
    environment: config.environment === 'production' ? 'production' : 'sandbox',
    tracker,
    tbt,
    source: 'hosted',
    redirect_url: redirectUrl,
    cancel_url: cancelUrl
  });
  if (orderRef) params.set('order_id', String(orderRef));
  if (customer) params.set('user_id', customer);
  if (customer && saveCard) params.set('is_implicit', 'true');
  return `${checkout}/embedded/?${params.toString()}`;
}

module.exports = {
  ENVIRONMENTS,
  INTENT,
  SOURCE,
  hostsFor,
  request,
  createTracker,
  addMetadata,
  createPassport,
  createCustomer,
  listWallet,
  deleteWalletMethod,
  runAction,
  fetchTracker,
  checkoutUrl
};
