// The orders export (Reports → Export → Orders), against a real MongoDB: it
// says what each order charged, what has come in and what is still owed. An
// unpaid order has no "Paid on" (it used to show the day it was created); a
// part-paid one reads "Part paid" with its balance and each payment; the
// member's code and phone are on the row; the currency is in capitals and the
// method is a word ("JazzCash"), the same in the CSV and the workbook.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let reports;
let member;

const at = (iso) => new Date(iso);
const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

function order(n, { payment, createdAt, userId = null, customerInfo = {}, status = 'active' }) {
  const { Types } = h.state.mongoose;
  return {
    _id: new Types.ObjectId(),
    orderNumber: `O-${n}`,
    userId,
    packageId: new Types.ObjectId(),
    packageDetails: { name: 'Monthly', price: '5000', currency: 'pkr', period: 'month', features: [] },
    customerInfo: { fullName: `Customer ${n}`, email: '', phone: '', country: '', ...customerInfo },
    payment: { currency: 'pkr', lastPaidAt: null, ...payment },
    subscription: { startDate: createdAt, endDate: new Date(createdAt.getTime() + 30 * 86400000), renewals: [] },
    status,
    createdAt,
    updatedAt: createdAt
  };
}

const test = h.suite(async () => {
  reports = h.src('controller/reportsController');
  const PackageOrder = h.src('gymfolio/models/packageOrderModel');
  const User = h.src('models/user');
  gym = await h.createGym('orders-export-gym', { timezone: 'UTC', currency: 'PKR' });

  await h.inGym(gym, async () => {
    member = await User.create({ firstName: 'Sana', lastName: 'Khan', phone: '0301-1234567', role: 'user', memberCode: 'GP-0042' });
    await PackageOrder.collection.insertMany([
      // Paid in full by JazzCash on 3 Oct.
      order(1, { createdAt: at('2026-10-03T09:00:00Z'), userId: member._id, payment: { method: 'jazzcash', amount: 5000, status: 'paid', paidAt: at('2026-10-03T09:00:00Z') } }),
      // Sold 5 Oct, 2,000 cash then; 1,000 by bank transfer on 12 Oct; 2,000 still owed.
      order(2, {
        createdAt: at('2026-10-05T09:00:00Z'),
        userId: member._id,
        payment: {
          method: 'cash',
          amount: 5000,
          status: 'paid',
          paidAt: at('2026-10-05T09:00:00Z'),
          amountPaid: 3000,
          balanceDue: 2000,
          installments: [
            { amount: 2000, method: 'cash', at: at('2026-10-05T09:00:00Z') },
            { amount: 1000, method: 'bank_transfer', at: at('2026-10-12T09:00:00Z') }
          ]
        }
      }),
      // Made on 7 Oct, nothing paid yet.
      order(3, { createdAt: at('2026-10-07T09:00:00Z'), customerInfo: { phone: '+92 333 1112223', email: 'guest@orders.test' }, payment: { method: 'bank_transfer', amount: 4000, status: 'pending' }, status: 'pending' })
    ]);
  });
});

test('orders export: total, paid and balance, real payment dates, member code, phone, readable method', async () => {
  const { unzip, readSheet, sheetObjects } = require('../helpers/readXlsx');
  const { dateSerial } = h.src('services/xlsx');

  await h.inGym(gym, async () => {
    const [csv, book] = await Promise.all([
      h.call(reports.export, { params: { kind: 'orders' }, query: OCTOBER }),
      h.call(reports.export, { params: { kind: 'orders' }, query: { ...OCTOBER, format: 'xlsx' } })
    ]);
    assert.equal(csv.statusCode, 200);
    assert.equal(book.statusCode, 200);

    const header = String(csv.body).replace(/^﻿/, '').split('\r\n')[0].split(',');
    for (const label of ['Member code', 'Phone', 'Total', 'Paid', 'Balance due', 'Payment', 'Method', 'Paid on', 'Last payment', 'Payments']) {
      assert.ok(header.includes(label), `${label} in ${header.join('|')}`);
    }
    assert.ok(!header.includes('Amount'), 'one ambiguous Amount column no more');
    assert.deepEqual(readSheet(unzip(book.body))[0].map((c) => c.value), header, 'the workbook has the CSV\'s columns');

    const rows = sheetObjects(unzip(book.body));
    const row = (n) => rows.find((r) => r.Order === `O-${n}`);

    const full = row(1);
    assert.equal(full['Member code'], 'GP-0042');
    assert.equal(full.Member, 'Customer 1');
    assert.equal(full.Phone, '0301-1234567', 'the member\'s phone when the order has none');
    assert.equal(full.Currency, 'PKR');
    assert.deepEqual([full.Total, full.Paid, full['Balance due']], [5000, 5000, 0]);
    assert.equal(full.Payment, 'Paid');
    assert.equal(full.Method, 'JazzCash');
    assert.equal(full['Paid on'], dateSerial('2026-10-03'));

    const part = row(2);
    assert.deepEqual([part.Total, part.Paid, part['Balance due']], [5000, 3000, 2000]);
    assert.equal(part.Payment, 'Part paid');
    assert.equal(part.Method, 'Cash + Bank transfer');
    assert.equal(part['Paid on'], dateSerial('2026-10-05'));
    assert.equal(part['Last payment'], dateSerial('2026-10-12'));
    assert.equal(part.Payments, '2026-10-05 2000 Cash; 2026-10-12 1000 Bank transfer');

    const unpaid = row(3);
    assert.deepEqual([unpaid.Total, unpaid.Paid, unpaid['Balance due']], [4000, 0, 4000]);
    assert.equal(unpaid.Payment, 'Not paid');
    assert.equal(unpaid['Paid on'], undefined, 'no payment date for an order nobody has paid');
    assert.equal(unpaid['Last payment'], undefined);
    assert.equal(unpaid['Member code'], undefined, 'a guest order has no member');
    assert.equal(unpaid.Email, 'guest@orders.test');
    assert.equal(unpaid['Membership status'], 'Pending');
  });
});
