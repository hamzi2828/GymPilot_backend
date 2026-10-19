// An order asked for by an id that is not one -- a mistyped link, a stale
// bookmark, a checkout session this gym's Stripe never issued -- is "not
// found" (404 ORDER_NOT_FOUND), over HTTP through the real routes. Looked up
// as it was, the id failed to cast and the answer was a 500.

const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let User;
let staff;
let member;

const test = h.suite(async () => {
  User = h.src('models/user');
  gym = await h.createGym('order-ids-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, async () => {
    staff = await User.create({ firstName: 'Desk', lastName: 'Staff', email: 'desk@order-ids.test', role: 'admin' });
    member = await User.create({ firstName: 'Mem', lastName: 'Ber', email: 'member@order-ids.test', role: 'user' });
  });
});

async function withServer(fn) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.tenant = gym;
    h.inGym(gym, async () => next()).catch(next);
  });
  app.use('/api/gymfolio', h.src('gymfolio/routes/gymfolioRoutes'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (user, method, path, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (user) {
      const token = jwt.sign({ id: String(user._id), email: user.email, role: user.role, tid: String(gym._id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '5m' });
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text };
  };
  try {
    return await fn(send);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function notFound(res, what) {
  assert.equal(res.status, 404, `${what}: ${res.text}`);
  assert.equal(res.body.code, 'ORDER_NOT_FOUND', what);
}

test('an order id that is not one is not found, for staff and for the member, on every order route', async () => {
  await withServer(async (send) => {
    for (const bad of ['not-an-id', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz']) {
      notFound(await send(staff, 'GET', `/api/gymfolio/package-orders/${bad}`), `staff GET ${bad}`);
      notFound(await send(member, 'GET', `/api/gymfolio/package-orders/${bad}`), `member GET ${bad}`);
    }
    // A well-formed id with no order behind it reads the same.
    notFound(await send(staff, 'GET', '/api/gymfolio/package-orders/64b7f0c2a1b2c3d4e5f60718'), 'unknown id');

    const writes = [
      ['POST', 'approve'],
      ['POST', 'reject'],
      ['POST', 'renew', { paymentMethod: 'cash' }],
      ['POST', 'change-package', { packageId: '64b7f0c2a1b2c3d4e5f60718' }],
      ['POST', 'use-session'],
      ['POST', 'payments', { amount: 10 }],
      ['POST', 'refund', { reason: 'x' }],
      ['PATCH', 'terms', { discountAmount: 1 }],
      ['POST', 'cancel'],
      ['POST', 'freeze', { days: 7 }],
      ['PUT', 'status', { status: 'active' }]
    ];
    for (const [method, action, body] of writes) {
      notFound(await send(staff, method, `/api/gymfolio/package-orders/not-an-id/${action}`, body), `${method} ${action}`);
    }
    notFound(await send(member, 'POST', '/api/gymfolio/package-orders/not-an-id/cancel-subscription', {}), 'member cancel-subscription');
  });
});

test('a checkout session this gym\'s Stripe has never seen is not found, not a server error; Stripe down still is one', async () => {
  const missing = Object.assign(new Error("No such checkout.session: 'cs_made_up'"), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
  h.setStripe({ checkout: { sessions: { retrieve: async () => { throw missing; } } } });
  try {
    await withServer(async (send) => {
      for (const [method, path] of [['GET', '/api/gymfolio/payment/verify/cs_made_up'], ['POST', '/api/gymfolio/payment/verify/cs_made_up']]) {
        const res = await send(null, method, path);
        notFound(res, `${method} verify`);
        assert.match(res.body.message, /We could not find an order for this payment/);
      }
    });

    h.setStripe({ checkout: { sessions: { retrieve: async () => { throw Object.assign(new Error('Stripe is down'), { type: 'StripeConnectionError' }); } } } });
    await withServer(async (send) => {
      const res = await send(null, 'GET', '/api/gymfolio/payment/verify/cs_down_123');
      assert.equal(res.status, 500, res.text);
    });
  } finally {
    h.setStripe(null);
  }
});
