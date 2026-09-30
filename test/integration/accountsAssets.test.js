// The asset register against a real MongoDB: what the list hands the edit
// form, and that saving the form after changing one field keeps every other
// one -- the warranty date and invoice number above all, which the form used
// to send back blank and the controller then cleared.
//
// The gym is in Asia/Karachi (UTC+5) so a date stored as local noon would
// come back as the wrong day if anything read it in UTC.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let Asset;
let assets;

const test = h.suite(async () => {
  Asset = h.src('accounts/models/assetModel');
  assets = h.src('accounts/controller/assetController');
  gym = await h.createGym('assets-gym', { timezone: 'Asia/Karachi', currency: 'PKR' });
  await h.inGym(gym, () => h.ensureIndexes(Asset));
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
