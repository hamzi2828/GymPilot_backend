// test/integration/helpers/fakeSafepay.js
//
// A stand-in for Safepay's API on a local port, speaking the endpoints
// services/safepay/api.js calls, so the connector is tested over real HTTP
// without ever reaching Safepay. The connector is pointed at it with
// SAFEPAY_API_BASE_URL (honoured only outside production).
//
// It checks what Safepay would check -- the merchant secret header and that
// the API key belongs to it -- keeps trackers, customers and wallets in
// memory, and records every request for assertions.

'use strict';

const http = require('http');
const crypto = require('crypto');

function createFakeSafepay({ secretKey = 'sec_test_secret', publicKey = 'pub_test_key' } = {}) {
  const state = {
    secretKey,
    publicKey,
    calls: [],
    trackers: new Map(),   // token -> { token, mode, amount, currency, user, state, metadata }
    customers: new Map(),  // token -> body
    wallets: new Map(),    // customer -> [entries]
    declined: new Set(),   // payment-method tokens a charge is refused for
    unreachable: false,
    next: 1
  };

  const id = (prefix) => `${prefix}_${String(state.next++).padStart(4, '0')}-${crypto.randomBytes(4).toString('hex')}`;

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function trackerView(tracker) {
    return {
      token: tracker.token,
      environment: 'sandbox',
      state: tracker.state,
      intent: 'CYBERSOURCE',
      mode: tracker.mode,
      purchase_totals: { quote_amount: { currency: tracker.currency, amount: tracker.amount }, base_amount: { currency: tracker.currency, amount: tracker.amount } }
    };
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

      if (state.unreachable) {
        req.socket.destroy();
        return;
      }
      if (req.headers['x-sfpy-merchant-secret'] !== state.secretKey) {
        return send(res, 401, { status: { errors: ['invalid merchant secret'], message: 'unauthorized' } });
      }

      const parts = url.pathname.split('/').filter(Boolean);

      // POST /order/payments/v3/
      if (req.method === 'POST' && url.pathname === '/order/payments/v3/') {
        if (!body || body.merchant_api_key !== state.publicKey) return send(res, 400, { status: { errors: ['merchant_api_key does not match the secret'] } });
        if (!Number.isInteger(body.amount) && body.mode !== 'instrument') return send(res, 400, { status: { errors: ['amount must be an integer in minor units'] } });
        const token = id('track');
        const tracker = { token, mode: body.mode, amount: body.amount, currency: body.currency, user: body.user || null, state: 'TRACKER_STARTED', metadata: body.metadata || {} };
        state.trackers.set(token, tracker);
        return send(res, 201, { data: { tracker: trackerView(tracker), capabilities: { CYBERSOURCE: true } }, status: { errors: [], message: 'success' } });
      }
      // POST /order/payments/v3/{tracker}/metadata
      if (req.method === 'POST' && parts[0] === 'order' && parts[3] && parts[4] === 'metadata') {
        const tracker = state.trackers.get(parts[3]);
        if (!tracker) return send(res, 404, { status: { errors: ['tracker not found'] } });
        tracker.metadata = { ...tracker.metadata, ...((body && body.data) || {}) };
        return send(res, 200, { data: {}, status: { errors: [], message: 'success' } });
      }
      // POST /order/payments/v3/{tracker} -- the next action (charge a saved card, capture)
      if (req.method === 'POST' && parts[0] === 'order' && parts.length === 4) {
        const tracker = state.trackers.get(parts[3]);
        if (!tracker) return send(res, 404, { status: { errors: ['tracker not found'] } });
        const card = body && body.payload && body.payload.payment_method && body.payload.payment_method.tokenized_card;
        if (card) {
          if (tracker.mode !== 'unscheduled_cof') return send(res, 400, { status: { errors: ['not a merchant initiated tracker'] } });
          if (state.declined.has(card.token)) {
            tracker.state = 'TRACKER_ENROLLED';
            return send(res, 402, { status: { errors: ['The card was declined by the issuing bank'] } });
          }
          const wallet = state.wallets.get(tracker.user) || [];
          if (!wallet.some((entry) => entry.token === card.token)) return send(res, 400, { status: { errors: ['unknown payment method'] } });
          tracker.state = 'TRACKER_ENDED';
        }
        return send(res, 200, { data: { tracker: trackerView(tracker) }, status: { errors: [], message: 'success' } });
      }
      // POST /client/passport/v1/token
      if (req.method === 'POST' && url.pathname === '/client/passport/v1/token') {
        return send(res, 201, { data: `tbt_${crypto.randomBytes(8).toString('hex')}==` });
      }
      // POST /user/customers/v1/
      if (req.method === 'POST' && url.pathname === '/user/customers/v1/') {
        const token = id('cus');
        state.customers.set(token, body);
        state.wallets.set(token, []);
        return send(res, 201, { data: { token, ...body }, status: { errors: [], message: 'success' } });
      }
      // GET / DELETE /user/customers/v1/{customer}/wallet/[{pm}]
      if (parts[0] === 'user' && parts[1] === 'customers' && parts[4] === 'wallet') {
        const wallet = state.wallets.get(parts[3]);
        if (!wallet) return send(res, 404, { status: { errors: ['customer not found'] } });
        if (req.method === 'GET') return send(res, 200, { data: { wallet, count: wallet.length }, status: { errors: [], message: 'success' } });
        if (req.method === 'DELETE' && parts[5]) {
          state.wallets.set(parts[3], wallet.filter((entry) => entry.token !== parts[5]));
          return send(res, 200, { data: {}, status: { errors: [], message: 'success' } });
        }
      }
      // GET /reporter/api/v1/payments/{tracker}
      if (req.method === 'GET' && url.pathname.startsWith('/reporter/api/v1/payments/')) {
        const tracker = state.trackers.get(parts[4]);
        if (!tracker) return send(res, 404, { status: { errors: ['tracker not found'] } });
        const paid = tracker.state === 'TRACKER_ENDED';
        const fee = Math.round(tracker.amount * 0.029) + 3000;
        return send(res, 200, {
          ok: true,
          data: {
            ...trackerView(tracker),
            charge: paid ? { amount: { currency: tracker.currency, amount: tracker.amount }, fees: { currency: tracker.currency, amount: fee }, net: { currency: tracker.currency, amount: tracker.amount - fee } } : undefined
          }
        });
      }
      return send(res, 404, { status: { errors: [`no route ${req.method} ${url.pathname}`] } });
    });
  });

  const fake = {
    state,
    get calls() {
      return state.calls;
    },
    callsTo(method, prefix) {
      return state.calls.filter((call) => call.method === method && call.path.startsWith(prefix));
    },
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      fake.base = `http://127.0.0.1:${server.address().port}`;
      return fake;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
    /** The member finished paying on Safepay's page: the tracker ends, and (when it was for a customer) the card is in their wallet. */
    pay(token, { saveCard = null } = {}) {
      const tracker = state.trackers.get(token);
      if (!tracker) throw new Error(`no tracker ${token}`);
      tracker.state = 'TRACKER_ENDED';
      if (tracker.user && saveCard) {
        const wallet = state.wallets.get(tracker.user) || [];
        wallet.push({
          token: saveCard.token || id('pm'),
          customer: tracker.user,
          is_deleted: false,
          cybersource: { scheme: saveCard.scheme ?? 2, bin: '520000', last_four: saveCard.last4 || '1096', expiry_month: '12', expiry_year: '2030' },
          created_at: { seconds: Math.floor(Date.now() / 1000) + wallet.length }
        });
        state.wallets.set(tracker.user, wallet);
      }
      return tracker;
    },
    setState(token, value) {
      state.trackers.get(token).state = value;
    },
    tracker(token) {
      return state.trackers.get(token);
    },
    /** A 2.0.0 webhook event for a tracker, and its signature with `secret` over the raw body. */
    event(token, type = 'payment.succeeded', { secret, amount, fee, net, state: trackerState, message } = {}) {
      const tracker = state.trackers.get(token) || { amount: 0, currency: 'PKR', metadata: {} };
      const data = {
        tracker: token,
        intent: 'CYBERSOURCE',
        state: trackerState || (type === 'payment.succeeded' ? 'TRACKER_ENDED' : 'TRACKER_ENROLLED'),
        amount: amount ?? tracker.amount,
        currency: tracker.currency,
        metadata: tracker.metadata || {},
        charged_at: { seconds: Math.floor(Date.now() / 1000) }
      };
      if (type === 'payment.succeeded') {
        data.fee = fee ?? 1475;
        data.net = net ?? data.amount - data.fee;
      }
      if (message) data.message = message;
      const body = JSON.stringify({ token: id('evt'), version: '2.0.0', merchant_api_key: state.publicKey, type, endpoint: 'https://api.test', data, created_at: { seconds: Math.floor(Date.now() / 1000) } });
      const signature = crypto.createHmac('sha512', secret || 'whsec_test').update(body).digest('hex');
      return { body, signature };
    }
  };
  return fake;
}

module.exports = { createFakeSafepay };
