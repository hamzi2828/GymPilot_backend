// Reading Stripe objects in both the pre-2025 and the "basil" (2025-03-31+)
// shapes. Pure functions over literal objects; no Stripe, no database.
const test = require('node:test');
const assert = require('node:assert/strict');

const { idOf, subscriptionIdOf, periodOf, paymentIntentOf, invoicePeriodOf } = require('../../src/gymfolio/services/stripeShapes');

test('idOf accepts a bare id or an expanded object', () => {
  assert.equal(idOf('sub_123'), 'sub_123');
  assert.equal(idOf({ id: 'sub_123', object: 'subscription' }), 'sub_123');
  assert.equal(idOf(null), null);
  assert.equal(idOf(undefined), null);
  assert.equal(idOf({}), null);
});

test('subscriptionIdOf reads the old top-level field and the basil parent block', () => {
  assert.equal(subscriptionIdOf({ subscription: 'sub_old' }), 'sub_old');
  assert.equal(subscriptionIdOf({ subscription: { id: 'sub_old_expanded' } }), 'sub_old_expanded');
  assert.equal(subscriptionIdOf({ parent: { subscription_details: { subscription: 'sub_basil' } } }), 'sub_basil');
  assert.equal(subscriptionIdOf({ parent: { subscription_details: { subscription: { id: 'sub_basil_expanded' } } } }), 'sub_basil_expanded');
  // A one-off invoice belongs to no subscription in either shape.
  assert.equal(subscriptionIdOf({ parent: { type: 'invoice_item_details' } }), null);
  assert.equal(subscriptionIdOf({}), null);
  assert.equal(subscriptionIdOf(null), null);
});

test('periodOf reads the subscription period from the top level or from the first item', () => {
  const old = periodOf({ current_period_start: 1735689600, current_period_end: 1738368000 });
  assert.equal(old.start.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(old.end.toISOString(), '2025-02-01T00:00:00.000Z');

  const basil = periodOf({ items: { data: [{ current_period_start: 1735689600, current_period_end: 1738368000 }] } });
  assert.equal(basil.start.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(basil.end.toISOString(), '2025-02-01T00:00:00.000Z');

  assert.deepEqual(periodOf({}), { start: null, end: null });
  assert.deepEqual(periodOf({ items: { data: [] } }), { start: null, end: null });
  assert.deepEqual(periodOf(null), { start: null, end: null });
});

test('paymentIntentOf reads invoice.payment_intent or the basil payments list', () => {
  assert.equal(paymentIntentOf({ payment_intent: 'pi_old' }), 'pi_old');
  assert.equal(paymentIntentOf({ payment_intent: { id: 'pi_old_expanded' } }), 'pi_old_expanded');
  assert.equal(
    paymentIntentOf({ payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_basil' } }] } }),
    'pi_basil'
  );
  assert.equal(paymentIntentOf({ payments: { data: [] } }), null);
  assert.equal(paymentIntentOf(null), null);
});

test('invoicePeriodOf takes the first dated line', () => {
  const period = invoicePeriodOf({ lines: { data: [{ period: null }, { period: { start: 1735689600, end: 1738368000 } }] } });
  assert.equal(period.start.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(period.end.toISOString(), '2025-02-01T00:00:00.000Z');
  assert.deepEqual(invoicePeriodOf({ lines: { data: [] } }), { start: null, end: null });
  assert.deepEqual(invoicePeriodOf(undefined), { start: null, end: null });
});
