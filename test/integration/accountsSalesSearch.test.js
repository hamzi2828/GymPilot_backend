// The Accounts sales list's search against a real MongoDB: besides the order
// number, name and email, it finds a sale by the phone on the order, and by
// the member ID or phone on the member's account -- typed the way the desk
// types them.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let PackageOrder;
let User;
let accounts;

function order(n, { userId = null, fullName, email, phone = '' }) {
  const { Types } = h.state.mongoose;
  const paidAt = new Date('2026-09-10T10:00:00Z');
  return {
    _id: new Types.ObjectId(),
    orderNumber: `SR-${n}`,
    userId,
    packageId: new Types.ObjectId(),
    packageDetails: { name: 'Monthly', price: '50', currency: 'gbp', period: 'month', features: [], kind: 'membership', durationDays: 30, sessions: 0, joiningFee: 0, billing: { mode: 'one_time', interval: 'month', intervalCount: 1, trialDays: 0 } },
    customerInfo: { fullName, email, phone, country: '' },
    payment: { method: 'cash', amount: 50, currency: 'gbp', status: 'paid', paidAt, lastPaidAt: null },
    subscription: { startDate: paidAt, endDate: new Date(paidAt.getTime() + 30 * 86400000), isActive: true, renewals: [] },
    status: 'active',
    refund: { amount: null, reason: '', at: null, byUserId: null, stripeRefundId: null },
    createdAt: paidAt,
    updatedAt: paidAt
  };
}

const test = h.suite(async () => {
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  User = h.src('models/user');
  accounts = h.src('accounts/controller/accountsController');
  gym = await h.createGym('sales-search-gym', { timezone: 'UTC', currency: 'GBP' });

  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder);
    // The order was bought at the desk, so it carries no phone of its own;
    // the member's account has both the phone and the member ID.
    const amna = await User.create({ firstName: 'Amna', lastName: 'Khan', email: 'amna@search.test', phone: '0300-1234567', memberCode: 'GP-0042' });
    await User.create({ firstName: 'Bilal', lastName: 'Shah', email: 'bilal@search.test', phone: '0333-9999999', memberCode: 'GP-0043' });
    await PackageOrder.collection.insertMany([
      order(1, { userId: amna._id, fullName: 'Amna Khan', email: 'amna@search.test' }),
      // A guest checkout: the phone is on the order only.
      order(2, { fullName: 'Guest Person', email: 'guest@search.test', phone: '+92 321 7654321' }),
      order(3, { fullName: 'Someone Else', email: 'else@search.test', phone: '0345 1111111' })
    ]);
  });
});

async function found(q) {
  const res = await h.call(accounts.sales, { query: { from: '2026-09-01', to: '2026-09-30', q } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.sales.map((row) => row.order_number).sort();
}

test('a member ID finds that member\'s sales, whatever its case', async () => {
  await h.inGym(gym, async () => {
    assert.deepEqual(await found('GP-0042'), ['SR-1']);
    assert.deepEqual(await found('gp-0042'), ['SR-1']);
  });
});

test('the phone on the member\'s account finds their sales, typed with or without separators', async () => {
  await h.inGym(gym, async () => {
    assert.deepEqual(await found('0300-1234567'), ['SR-1']);
    assert.deepEqual(await found('03001234567'), ['SR-1']);
    assert.deepEqual(await found('0300 1234567'), ['SR-1']);
  });
});

test('the phone on the order finds a guest\'s sale', async () => {
  await h.inGym(gym, async () => {
    assert.deepEqual(await found('321 7654321'), ['SR-2']);
    assert.deepEqual(await found('3217654321'), ['SR-2']);
  });
});

test('order number, name and email still work, and a term matching nobody finds nothing', async () => {
  await h.inGym(gym, async () => {
    assert.deepEqual(await found('SR-3'), ['SR-3']);
    assert.deepEqual(await found('amna'), ['SR-1']);
    assert.deepEqual(await found('guest@search'), ['SR-2']);
    assert.deepEqual(await found('GP-0043'), [], 'a member with no sales');
    assert.deepEqual(await found('nobody-at-all'), []);
  });
});

test('the payment-method filter goes by how each payment was made, as the totals do', async () => {
  await h.inGym(gym, async () => {
    // Sold for cash, and the rest paid later by JazzCash.
    const split = order(9, { fullName: 'Split Payer', email: 'split@search.test' });
    const at = (iso) => new Date(iso);
    split.createdAt = at('2026-10-05T10:00:00Z');
    split.payment = {
      ...split.payment,
      paidAt: at('2026-10-05T10:00:00Z'),
      amountPaid: 50,
      balanceDue: 0,
      installments: [
        { amount: 30, joiningFee: 0, trainerFee: 0, method: 'cash', at: at('2026-10-05T10:00:00Z') },
        { amount: 20, joiningFee: 0, trainerFee: 0, method: 'jazzcash', at: at('2026-10-06T10:00:00Z') }
      ]
    };
    await PackageOrder.collection.insertOne(split);

    const list = async (method) => {
      const res = await h.call(accounts.sales, { query: { from: '2026-10-01', to: '2026-10-31', ...(method ? { method } : {}) } });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      const { sales, summary } = res.body;
      return {
        rows: sales.map((row) => [row.method, row.amount]),
        total: summary.base_amount,
        methods: summary.by_method.map((entry) => [entry.method, entry.totals.base_amount])
      };
    };

    const all = await list();
    assert.deepEqual(all.rows.sort(), [['cash', 30], ['jazzcash', 20]]);
    assert.equal(all.total, 50);

    assert.deepEqual(await list('jazzcash'), { rows: [['jazzcash', 20]], total: 20, methods: [['jazzcash', 20]] });
    assert.deepEqual(await list('cash'), { rows: [['cash', 30]], total: 30, methods: [['cash', 30]] });
  });
});
