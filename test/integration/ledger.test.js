// Money pipelines against a real MongoDB: ledger.membershipPaymentStages /
// membershipRefundStages / netResult, run through the accounts overview, the
// sales report and the reports overview exactly as the screens call them.
//
// One gym in Asia/Karachi (UTC+5, no DST) so a payment late on 31 July UTC
// is already 1 August at the gym. Seeded across June-August 2026:
//
//   O1  paid 5 Jul 50            renewal 5 Aug 50
//   O2  created 10 Jul, paidAt OVERWRITTEN by its renewal (10 Aug) 40 --
//       first payment must come from createdAt (July), renewal in August
//   O3  paid 15 Aug 30, refunded in full 20 Aug        -> nets to zero
//   O4  paid 20 Jul 60, refunded 20 on 2 Aug           -> +60 Jul, -20 Aug
//   O5  paid 25 Jul 10, refunded before refund.at existed -> -10 in July
//   O6  pending 999                                     -> never money
//   O7  paid 3 Jul 5000 PKR                             -> never netted into GBP
//   O8  paid 31 Jul 20:30 UTC = 1 Aug 01:30 PKT, 7      -> August
//   O9  paid 10 Jun 25, renewals 10 Jul 25 and 10 Aug 25
//   O10 paid 30 Jun 20:00 UTC = 1 Jul 01:00 PKT, 15     -> July
//
//   June GBP: in 25                     net 25
//   July GBP: in 200, refunds 10        net 190   (+ PKR 5000 on its own)
//   Aug  GBP: in 152, refunds 50        net 102

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

const test = h.suite(setup);

let gym;
let refundGym;
let L;
let PackageOrder;
let accounts;
let reports;
let membershipService;

const at = (iso) => new Date(iso);

function order(n, { createdAt, paidAt = createdAt, amount, currency = 'gbp', status = 'paid', renewals = [], refund, method = 'stripe' }) {
  const { Types } = h.state.mongoose;
  const doc = {
    _id: new Types.ObjectId(),
    orderNumber: `IT-${n}`,
    userId: null,
    packageId: new Types.ObjectId(),
    packageDetails: {
      name: renewals.length ? 'Monthly (recurring)' : 'Monthly',
      price: String(amount),
      currency,
      period: 'month',
      features: [],
      kind: 'membership',
      durationDays: 0,
      sessions: 0,
      joiningFee: 0,
      billing: { mode: renewals.length ? 'recurring' : 'one_time', interval: 'month', intervalCount: 1, trialDays: 0 }
    },
    customerInfo: { fullName: `Customer ${n}`, email: `c${n}@example.test`, phone: '', country: '' },
    payment: { method, amount, currency, status, paidAt: status === 'pending' ? null : paidAt, lastPaidAt: null },
    subscription: {
      startDate: paidAt,
      endDate: new Date(paidAt.getTime() + 30 * 86400000),
      isActive: status === 'paid',
      renewals
    },
    status: status === 'refunded' ? 'cancelled' : status === 'paid' ? 'active' : 'pending',
    createdAt,
    updatedAt: createdAt
  };
  // O5 predates the refund block entirely: no `refund` field at all.
  if (refund !== undefined) doc.refund = refund;
  else if (status !== 'refunded') doc.refund = { amount: null, reason: '', at: null, byUserId: null, stripeRefundId: null };
  return doc;
}

// Two gyms; the orders are seeded straight into the first one.
async function setup() {
  L = h.src('accounts/services/ledger');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  accounts = h.src('accounts/controller/accountsController');
  reports = h.src('controller/reportsController');
  membershipService = h.src('gymfolio/services/membershipService');

  gym = await h.createGym('ledger-gym', { timezone: 'Asia/Karachi', currency: 'GBP' });
  refundGym = await h.createGym('refund-gym', { timezone: 'UTC', currency: 'GBP' });

  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    await PackageOrder.collection.insertMany([
      order(1, {
        createdAt: at('2026-07-05T08:59:00Z'),
        paidAt: at('2026-07-05T09:00:00Z'),
        amount: 50,
        renewals: [{ at: at('2026-08-05T09:00:00Z'), amount: 50, currency: 'gbp', invoiceId: 'in_1' }]
      }),
      order(2, {
        createdAt: at('2026-07-10T10:00:00Z'),
        // Overwritten by the renewal, 30 seconds after it.
        paidAt: at('2026-08-10T10:00:30Z'),
        amount: 40,
        currency: 'GBP',
        renewals: [{ at: at('2026-08-10T10:00:00Z'), amount: 40, currency: '' }]
      }),
      order(3, {
        createdAt: at('2026-08-15T12:00:00Z'),
        amount: 30,
        status: 'refunded',
        refund: { amount: 30, reason: 'changed mind', at: at('2026-08-20T12:00:00Z'), byUserId: null, stripeRefundId: 're_3' }
      }),
      order(4, {
        createdAt: at('2026-07-20T12:00:00Z'),
        amount: 60,
        status: 'refunded',
        refund: { amount: 20, reason: 'partial', at: at('2026-08-02T12:00:00Z'), byUserId: null, stripeRefundId: 're_4' }
      }),
      order(5, { createdAt: at('2026-07-25T12:00:00Z'), amount: 10, status: 'refunded', method: 'cash' }),
      order(6, { createdAt: at('2026-07-12T12:00:00Z'), amount: 999, status: 'pending', method: 'bank_transfer' }),
      order(7, { createdAt: at('2026-07-03T12:00:00Z'), amount: 5000, currency: 'pkr', method: 'cash' }),
      order(8, { createdAt: at('2026-07-31T20:30:00Z'), amount: 7 }),
      order(9, {
        createdAt: at('2026-06-10T12:00:00Z'),
        amount: 25,
        renewals: [
          { at: at('2026-07-10T12:00:00Z'), amount: 25, currency: 'gbp' },
          { at: at('2026-08-10T12:00:00Z'), amount: 25, currency: 'gbp' }
        ]
      }),
      order(10, { createdAt: at('2026-06-30T20:00:00Z'), amount: 15 })
    ]);
  });
}

test('the payment pipeline returns one row per payment, each in its local month', async () => {
  await h.inGym(gym, async () => {
    const july = L.readRange({ from: '2026-07-01', to: '2026-07-31' });
    const rows = await PackageOrder.aggregate(L.membershipPaymentStages(july));
    const seen = rows.map((r) => `${r.orderNumber}:${r.kind}:${r.amount}:${r.currency}`).sort();
    assert.deepEqual(seen, [
      'IT-10:initial:15:GBP',
      'IT-1:initial:50:GBP',
      'IT-2:initial:40:GBP',
      'IT-4:initial:60:GBP',
      'IT-5:initial:10:GBP',
      'IT-7:initial:5000:PKR',
      'IT-9:renewal:25:GBP'
    ]);
    // The overwritten order's first payment is dated by createdAt.
    const o2 = rows.find((r) => r.orderNumber === 'IT-2');
    assert.equal(o2.at.toISOString(), '2026-07-10T10:00:00.000Z');

    const august = L.readRange({ from: '2026-08-01', to: '2026-08-31' });
    const augRows = await PackageOrder.aggregate(L.membershipPaymentStages(august));
    const augSeen = augRows.map((r) => `${r.orderNumber}:${r.kind}:${r.amount}`).sort();
    assert.deepEqual(augSeen, ['IT-1:renewal:50', 'IT-2:renewal:40', 'IT-3:initial:30', 'IT-8:initial:7', 'IT-9:renewal:25']);
    // A renewal with no currency of its own takes the order's.
    assert.equal(augRows.find((r) => r.orderNumber === 'IT-2').currency, 'GBP');
  });
});

test('the refund pipeline dates each refund when the money went back', async () => {
  await h.inGym(gym, async () => {
    const july = await PackageOrder.aggregate(L.membershipRefundStages(L.readRange({ from: '2026-07-01', to: '2026-07-31' })));
    // Only the legacy refund (no refund.at): filed on its payment day, whole amount.
    assert.deepEqual(july.map((r) => `${r.orderNumber}:${r.amount}`), ['IT-5:10']);

    const august = await PackageOrder.aggregate(L.membershipRefundStages(L.readRange({ from: '2026-08-01', to: '2026-08-31' })));
    assert.deepEqual(august.map((r) => `${r.orderNumber}:${r.amount}`).sort(), ['IT-3:30', 'IT-4:20']);
  });
});

test('a fully refunded order nets to zero in its month', async () => {
  await h.inGym(gym, async () => {
    const august = L.readRange({ from: '2026-08-01', to: '2026-08-31' });
    const match = { orderNumber: 'IT-3' };
    const [paid] = await PackageOrder.aggregate([...L.membershipPaymentStages(august, match), { $group: { _id: '$currency', total: { $sum: '$amount' } } }]);
    const [back] = await PackageOrder.aggregate([...L.membershipRefundStages(august, match), { $group: { _id: '$currency', total: { $sum: '$amount' } } }]);
    const result = L.netResult({ revenue: { [paid._id]: paid.total }, refunds: { [back._id]: back.total }, spent: {} }, 'GBP');
    assert.equal(paid.total, 30);
    assert.equal(back.total, 30);
    assert.equal(result.gross_income, 0);
    assert.equal(result.net, 0);
  });
});

test('accounts overview: per-month totals, renewals in their month, refunds netted once', async () => {
  await h.inGym(gym, async () => {
    const july = await h.call(accounts.overview, { query: { from: '2026-07-01', to: '2026-07-31' } });
    assert.equal(july.statusCode, 200, JSON.stringify(july.body));
    const j = july.body;
    assert.equal(j.base_currency, 'GBP');
    assert.equal(j.currency_notice, null);
    assert.equal(j.income.base_amount, 200);
    assert.deepEqual(j.income.by_currency, [{ currency: 'GBP', amount: 200 }, { currency: 'PKR', amount: 5000 }]);
    assert.equal(j.income.refunds.base_amount, 10);
    assert.equal(j.income.orders, 7, 'seven payments in July, the PKR one included');
    assert.equal(j.result.gross_income, 190);
    assert.equal(j.result.net, 190);
    assert.equal(j.result.mixed_currencies, true);
    const julyDay = (key) => j.trend.points.find((p) => p.key === key).revenue;
    assert.equal(julyDay('2026-07-01'), 15, '20:00 UTC on 30 June is 1 July in Karachi');
    assert.equal(julyDay('2026-07-10'), 65, 'O2 first payment (createdAt) + O9 renewal');
    assert.equal(julyDay('2026-07-25'), 0, 'a legacy refund is taken off on its payment day');
    assert.equal(julyDay('2026-07-31'), 0, 'O8 belongs to 1 August locally');

    const august = await h.call(accounts.overview, { query: { from: '2026-08-01', to: '2026-08-31' } });
    assert.equal(august.statusCode, 200, JSON.stringify(august.body));
    const a = august.body;
    assert.equal(a.income.base_amount, 152);
    assert.equal(a.income.refunds.base_amount, 50);
    assert.equal(a.income.orders, 5);
    assert.equal(a.result.gross_income, 102);
    const augDay = (key) => a.trend.points.find((p) => p.key === key).revenue;
    assert.equal(augDay('2026-08-01'), 7);
    assert.equal(augDay('2026-08-02'), -20);
    assert.equal(augDay('2026-08-05'), 50);
    assert.equal(augDay('2026-08-10'), 65, 'O2 renewal counted once, not twice');
    assert.equal(augDay('2026-08-15'), 30);
    assert.equal(augDay('2026-08-20'), -30);
  });
});

test('sales report agrees with the overview and splits renewals from new business', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(accounts.sales, { query: { from: '2026-08-01', to: '2026-08-31', status: 'all' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const s = res.body.summary;
    assert.equal(s.base_amount, 152);
    assert.equal(s.refunds.base_amount, 50);
    assert.equal(s.orders, 5);
    assert.equal(s.renewals, 3);
    assert.equal(s.new_business, 2);
    assert.equal(res.body.sales.length, 5);
    // Each renewal row has an id of its own.
    assert.equal(new Set(res.body.sales.map((row) => row.id)).size, 5);
  });
});

test('reports overview buckets the same money by month in the gym\'s timezone', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(reports.overview, { query: { from: '2026-06-01', to: '2026-08-31' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.range.grain, 'month');
    const byMonth = Object.fromEntries(res.body.series.membership_revenue.map((b) => [b.key, b.value]));
    assert.deepEqual(byMonth, { '2026-06': 25, '2026-07': 190, '2026-08': 102 });
    assert.equal(res.body.kpis.membership_revenue, 317);
    assert.deepEqual(res.body.other_currencies, [{ currency: 'PKR', total: 5000, orders: 1 }]);
  });
});

test('membershipService.refund on a cash order: counted in, taken off once, nets to zero', async () => {
  await h.inGym(refundGym, async () => {
    const doc = order(100, { createdAt: new Date(), amount: 45, method: 'cash' });
    await PackageOrder.collection.insertOne(doc);
    const loaded = await PackageOrder.findById(doc._id);
    await membershipService.refund(loaded, { reason: 'test' });

    const stored = await PackageOrder.findById(doc._id).lean();
    assert.equal(stored.payment.status, 'refunded');
    assert.equal(stored.refund.amount, 45);
    assert.ok(stored.refund.at instanceof Date);

    // Refunding again is refused.
    await assert.rejects(membershipService.refund(await PackageOrder.findById(doc._id)), /already been refunded/);

    const res = await h.call(accounts.overview, { query: {} });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.income.base_amount, 45);
    assert.equal(res.body.income.refunds.base_amount, 45);
    assert.equal(res.body.result.gross_income, 0);
  });
});

test(
  'two refunds of one card order at once reach Stripe once',
  async () => {
    const created = [];
    h.setStripe({
      refunds: {
        create: async (params) => {
          created.push(params);
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { id: `re_${created.length}`, amount: params.amount, currency: 'gbp' };
        }
      }
    });
    try {
      await h.inGym(refundGym, async () => {
        const doc = order(101, { createdAt: new Date(), amount: 100, method: 'stripe' });
        doc.payment.stripePaymentIntentId = 'pi_integration';
        await PackageOrder.collection.insertOne(doc);
        const [a, b] = await Promise.all([PackageOrder.findById(doc._id), PackageOrder.findById(doc._id)]);
        const outcomes = await Promise.allSettled([
          membershipService.refund(a, { amount: 40 }),
          membershipService.refund(b, { amount: 40 })
        ]);
        assert.equal(created.length, 1, `Stripe was asked for ${created.length} refunds of 40 (${outcomes.map((o) => o.status).join(', ')})`);
      });
    } finally {
      h.setStripe(null);
    }
  }
);
