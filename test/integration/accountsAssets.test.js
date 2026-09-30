// The asset register against a real MongoDB: what the list hands the edit
// form, and that saving the form after changing one field keeps every other
// one -- the warranty date and invoice number above all, which the form used
// to send back blank and the controller then cleared. Then the register's
// purchase-date filter, and the service and warranty reminders the admin bell
// counts, which must be exactly the rows its links open on.
//
// The gym is in Asia/Karachi (UTC+5) so a date stored as local noon would
// come back as the wrong day if anything read it in UTC.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let reminderGym;
let Asset;
let assets;
let bell;

const test = h.suite(async () => {
  Asset = h.src('accounts/models/assetModel');
  assets = h.src('accounts/controller/assetController');
  bell = h.src('controller/adminNotificationsController');
  gym = await h.createGym('assets-gym', { timezone: 'Asia/Karachi', currency: 'PKR' });
  reminderGym = await h.createGym('asset-reminders-gym', { timezone: 'UTC', currency: 'GBP' });
  await h.inGym(gym, () => h.ensureIndexes(Asset));
  await h.inGym(reminderGym, () => h.ensureIndexes(Asset));
});

const user = { id: null, firstName: 'Ada', lastName: 'Admin' };

// The body the admin page's edit form sends: every field, pre-filled from the
// list row (admin/accounts/page.tsx openAsset), with `change` applied.
function formBodyFrom(row, change = {}) {
  return {
    name: row.name,
    category: row.category,
    quantity: String(row.quantity),
    unitCost: String(row.unit_cost),
    currency: row.currency,
    purchasedOn: row.purchased_date,
    supplier: row.supplier,
    invoiceNo: row.invoice_no,
    serialNumber: row.serial_number,
    warrantyUntil: row.warranty_date,
    location: row.location,
    condition: row.condition,
    status: row.status,
    usefulLifeYears: String(row.useful_life_years || ''),
    salvageValue: String(row.salvage_value || ''),
    serviceIntervalDays: String(row.service_interval_days || ''),
    lastServicedOn: row.last_serviced_date,
    notes: row.notes,
    recordExpense: false,
    ...change
  };
}

test('the list gives the edit form every date as the gym-local YYYY-MM-DD, and the invoice number', async () => {
  await h.inGym(gym, async () => {
    const created = await h.call(assets.create, {
      user,
      body: {
        name: 'Treadmill T5',
        category: 'cardio',
        quantity: '2',
        unitCost: '150000',
        purchasedOn: '2026-01-15',
        supplier: 'FitSupply',
        invoiceNo: 'INV-778',
        serialNumber: 'SN-1',
        warrantyUntil: '2027-01-15',
        location: 'Cardio floor',
        serviceIntervalDays: '90',
        lastServicedOn: '2026-06-01'
      }
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));

    const res = await h.call(assets.list, { query: {} });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const row = res.body.assets.find((entry) => entry.name === 'Treadmill T5');
    assert.equal(row.purchased_date, '2026-01-15');
    assert.equal(row.warranty_date, '2027-01-15');
    assert.equal(row.last_serviced_date, '2026-06-01');
    assert.equal(row.next_service_date, '2026-08-30');
    assert.equal(row.invoice_no, 'INV-778');
  });
});

test('editing one field through the form keeps the warranty, invoice and every date', async () => {
  await h.inGym(gym, async () => {
    const before = (await h.call(assets.list, { query: {} })).body.assets.find((entry) => entry.name === 'Treadmill T5');

    const res = await h.call(assets.update, { user, params: { id: before.id }, body: formBodyFrom(before, { location: 'Upstairs' }) });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));

    const stored = await Asset.findById(before.id).lean();
    assert.equal(stored.location, 'Upstairs');
    assert.equal(stored.invoiceNo, 'INV-778');
    assert.equal(stored.supplier, 'FitSupply');
    assert.equal(stored.serialNumber, 'SN-1');
    assert.equal(stored.quantity, 2);
    assert.equal(stored.unitCost, 150000);

    const after = res.body.asset;
    for (const field of ['purchased_date', 'warranty_date', 'last_serviced_date', 'next_service_date', 'invoice_no']) {
      assert.equal(after[field], before[field], `${field} changed on an unrelated edit`);
    }
  });
});

test('clearing a field on purpose still clears it', async () => {
  await h.inGym(gym, async () => {
    const before = (await h.call(assets.list, { query: {} })).body.assets.find((entry) => entry.name === 'Treadmill T5');
    const res = await h.call(assets.update, { user, params: { id: before.id }, body: formBodyFrom(before, { warrantyUntil: '', invoiceNo: '' }) });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.asset.warranty_date, '');
    assert.equal(res.body.asset.invoice_no, '');
    assert.equal(res.body.asset.purchased_date, '2026-01-15');
  });
});

test('the register filters by purchase date, either end open, and opens on every date', async () => {
  await h.inGym(gym, async () => {
    await h.call(assets.create, { user, body: { name: 'Rower', category: 'cardio', unitCost: '1000', purchasedOn: '2026-09-10' } });
    await h.call(assets.create, { user, body: { name: 'Bench', category: 'strength', unitCost: '500', purchasedOn: '2026-09-30' } });

    const names = (res) => res.body.assets.map((row) => row.name).sort();

    const all = await h.call(assets.list, { query: {} });
    assert.deepEqual(names(all), ['Bench', 'Rower', 'Treadmill T5']);
    assert.equal(all.body.purchased, null);

    const september = await h.call(assets.list, { query: { from: '2026-09-01', to: '2026-09-30' } });
    assert.deepEqual(names(september), ['Bench', 'Rower']);
    assert.equal(september.body.summary.count, 2, 'the summary covers the same assets');
    assert.equal(september.body.summary.cost.base_amount, 1500);
    assert.deepEqual(september.body.purchased, { from: '2026-09-01', to: '2026-09-30', label: 'Sep 2026' });

    // The last day counts whole, in the gym's own day (noon PKT is 07:00 UTC).
    const lastDay = await h.call(assets.list, { query: { from: '2026-09-30', to: '2026-09-30' } });
    assert.deepEqual(names(lastDay), ['Bench']);

    const upTo = await h.call(assets.list, { query: { to: '2026-09-15' } });
    assert.deepEqual(names(upTo), ['Rower', 'Treadmill T5']);
    const since = await h.call(assets.list, { query: { from: '2026-09-11' } });
    assert.deepEqual(names(since), ['Bench']);
  });
});

test('service-due and warranty-ending: the list and the bell count the same machines', async () => {
  await h.inGym(reminderGym, async () => {
    const DAY = 86400000;
    const now = Date.now();
    const inDays = (n) => new Date(now + n * DAY);
    const seed = (name, fields) => Asset.create({ tag: `AST-${name}`, name, category: 'cardio', ...fields });
    await Promise.all([
      seed('due-in-3', { nextServiceDue: inDays(3) }),
      seed('overdue', { nextServiceDue: inDays(-10), status: 'maintenance' }),
      seed('due-in-20', { nextServiceDue: inDays(20) }),
      seed('retired-overdue', { nextServiceDue: inDays(-10), status: 'retired' }),
      seed('warranty-10', { warrantyUntil: inDays(10) }),
      seed('warranty-60', { warrantyUntil: inDays(60) }),
      seed('warranty-ended', { warrantyUntil: inDays(-1) }),
      seed('sold-warranty-10', { warrantyUntil: inDays(10), status: 'sold' })
    ]);

    const names = (res) => res.body.assets.map((row) => row.name).sort();
    const due = await h.call(assets.list, { query: { service: 'due' } });
    assert.deepEqual(names(due), ['due-in-3', 'overdue']);
    const ending = await h.call(assets.list, { query: { warranty: 'ending' } });
    assert.deepEqual(names(ending), ['warranty-10']);
    assert.equal(due.body.summary.service_due, 2);
    assert.equal(due.body.summary.warranty_ending, 1);

    const res = h.fakeRes();
    await bell.list({ roleSlug: 'admin' }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const items = Object.fromEntries(res.body.data.map((item) => [item.key, item]));
    assert.equal(items.asset_services_due.count, due.body.assets.length);
    assert.equal(items.asset_warranties_ending.count, ending.body.assets.length);
    assert.equal(items.asset_services_due.href, '/admin/accounts?tab=assets&service=due');
    assert.equal(items.asset_warranties_ending.href, '/admin/accounts?tab=assets&warranty=ending');

    // Logging the service clears it from both.
    const overdue = due.body.assets.find((row) => row.name === 'overdue');
    await h.call(assets.logService, { user, params: { id: overdue.id }, body: { serviceIntervalDays: 90 } });
    const after = await h.call(assets.list, { query: { service: 'due' } });
    assert.deepEqual(names(after), ['due-in-3']);
  });
});
