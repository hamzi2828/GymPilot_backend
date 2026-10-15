// One currency per gym: the one in Settings → General → Money.
//
// Each catalogue item used to keep its own `currency`, so a gym whose
// settings said USD could still show packages in GBP. Now the settings
// currency is the currency of everything the gym sells: reads hand it back
// whatever the item's own field says, a write cannot set another, and
// changing the setting relabels the catalogue (never converting an amount).
// Money already taken keeps the currency it was taken in.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let settings;
let packages;
let classes;
let pos;
let orders;
let Package;
let GymClass;
let Coupon;
let Product;
let Locker;
let User;
let PackageOrder;
let Sale;

// Rows written straight to the collection, past the model hooks: what a
// gym's database holds from before the catalogue followed the setting.
const ids = {};

const test = h.suite(async () => {
  settings = h.src('controller/settingsController');
  packages = h.src('gymfolio/controller/packageController');
  classes = h.src('gymfolio/controller/gymClassController');
  pos = h.src('controller/posController');
  orders = h.src('gymfolio/controller/gymfolioPaymentController');
  Package = h.src('gymfolio/models/packageModel');
  GymClass = h.src('gymfolio/models/gymClassModel');
  Coupon = h.src('gymfolio/models/couponModel');
  Product = h.src('models/productModel');
  Locker = h.src('models/lockerModel');
  User = h.src('models/user');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Sale = h.src('models/saleModel');

  gym = await h.createGym('currency-gym', { currency: 'USD' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PackageOrder, Sale);
    const now = new Date();
    const pkg = { period: 'month', features: ['Gym floor'], isActive: true, kind: 'membership', billing: { mode: 'one_time', interval: 'month', intervalCount: 1, trialDays: 0 }, durationDays: 0, sessions: 0, joiningFee: 0, createdAt: now, updatedAt: now };
    ids.monthly = (await Package.collection.insertOne({ ...pkg, name: 'Monthly', price: '24', priceAmount: 24, currency: 'GBP', order: 1 })).insertedId;
    ids.pt = (await Package.collection.insertOne({ ...pkg, name: 'PT x5', price: '79', priceAmount: 79, currency: 'GBP', kind: 'pt_pack', sessions: 5, order: 2 })).insertedId;
    ids.class = (await GymClass.collection.insertOne({ name: 'Spin', slug: 'spin', price: 10, currency: 'GBP', isActive: true, createdAt: now, updatedAt: now })).insertedId;
    ids.coupon = (await Coupon.collection.insertOne({ code: 'FIVEOFF', type: 'amount', value: 5, currency: 'GBP', packageIds: [], isActive: true, redemptions: 0, maxRedemptions: 0 })).insertedId;
    ids.product = (await Product.collection.insertOne({ name: 'Water', price: 1.5, cost: 0.5, currency: 'GBP', isActive: true, trackStock: false, stock: 0 })).insertedId;
    ids.locker = (await Locker.collection.insertOne({ number: '1', zone: 'A', status: 'free', fee: 3, currency: 'GBP' })).insertedId;
    ids.staff = (await User.collection.insertOne({ firstName: 'Sam', lastName: 'Staff', email: 'sam@currency.test', role: 'admin', employment: { isStaff: true, payroll: { basis: 'salaried', salary: 2000, currency: 'GBP', cycle: 'monthly' } } })).insertedId;
    ids.member = (await User.collection.insertOne({ firstName: 'Mo', lastName: 'Member', email: 'mo@currency.test', role: 'user', createdAt: now, updatedAt: now })).insertedId;

    // Money already taken, in the old currency.
    ids.paidOrder = (await PackageOrder.collection.insertOne({
      userId: ids.member,
      packageId: ids.monthly,
      packageDetails: { name: 'Monthly', price: '24', currency: 'GBP', period: 'month', features: [], kind: 'membership' },
      customerInfo: { firstName: 'Mo', lastName: 'Member', email: 'mo@currency.test' },
      payment: { method: 'cash', amount: 24, currency: 'GBP', status: 'paid', paidAt: now },
      status: 'expired',
      createdAt: now,
      updatedAt: now
    })).insertedId;
    ids.sale = (await Sale.collection.insertOne({ receiptNumber: 'R-OLD-1', items: [], total: 3, currency: 'GBP', status: 'paid', paymentMethod: 'cash', paidAt: now })).insertedId;
  });
});

const req = (extra = {}) => ({ headers: { host: 'api.currency-gym.test' }, protocol: 'https', user: { id: 'staff', email: 'owner@currency.test' }, ...extra });
const raw = (collection, id) => h.rawDb(gym.database.name).collection(collection).findOne({ _id: id });

test('before any relabel, every catalogue read is in the gym currency, not the stale field', async () => {
  await h.inGym(gym, async () => {
    const list = await h.call(packages.getActivePackages, req());
    assert.equal(list.statusCode, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.data.map((p) => p.currency), ['USD', 'USD']);

    const lean = await GymClass.findById(ids.class).lean();
    assert.equal(lean.currency, 'USD');
    assert.equal((await Coupon.findOne({ code: 'FIVEOFF' })).currency, 'USD');
    const products = await h.call(pos.listProducts, req({ query: {} }));
    assert.equal(products.body.data[0].currency, 'USD');
    const lockers = await h.call(pos.listLockers, req({ query: {} }));
    assert.equal(lockers.body.data[0].currency, 'USD');

    // The stored field is untouched by a read.
    assert.equal((await raw('packages', ids.monthly)).currency, 'GBP');
  });
});

test('changing the currency relabels the catalogue and staff pay, amounts unchanged, history kept', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(settings.updateSettings, req({ body: { currency: 'pkr' } }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.currency, 'PKR');
    assert.deepEqual(res.body.currency_relabelled, { packages: 2, classes: 1, coupons: 1, products: 1, lockers: 1, staffPay: 1 });

    const monthly = await raw('packages', ids.monthly);
    assert.equal(monthly.currency, 'PKR');
    assert.equal(monthly.price, '24', 'no exchange rate: 24 stays 24');
    const pt = await raw('packages', ids.pt);
    assert.equal(pt.currency, 'PKR');
    assert.equal(pt.price, '79');
    const spin = await raw('gymclasses', ids.class);
    assert.equal(spin.currency, 'PKR');
    assert.equal(spin.price, 10);
    const coupon = await raw('gym_coupons', ids.coupon);
    assert.equal(coupon.currency, 'PKR');
    assert.equal(coupon.value, 5);
    const product = await raw('gym_products', ids.product);
    assert.equal(product.currency, 'PKR');
    assert.equal(product.price, 1.5);
    const locker = await raw('gym_lockers', ids.locker);
    assert.equal(locker.currency, 'PKR');
    assert.equal(locker.fee, 3);
    const staff = await raw('users', ids.staff);
    assert.equal(staff.employment.payroll.currency, 'PKR');
    assert.equal(staff.employment.payroll.salary, 2000);

    // History is not rewritten.
    const paid = await raw('packageorders', ids.paidOrder);
    assert.equal(paid.payment.currency, 'GBP');
    assert.equal(paid.packageDetails.currency, 'GBP');
    assert.equal((await raw('gym_sales', ids.sale)).currency, 'GBP');

    // The platform record follows the setting, as before.
    const Gym = h.src('platform/models/gymModel');
    assert.equal((await Gym.findById(gym._id).lean()).locale.currency, 'PKR');
  });
});

test('saving the same currency again changes nothing (idempotent)', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(settings.updateSettings, req({ body: { currency: 'PKR' } }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.currency_relabelled, { packages: 0, classes: 0, coupons: 0, products: 0, lockers: 0, staffPay: 0 });
  });
});

test('the public package list and a new order are in the new currency; the old order is not', async () => {
  await h.inGym(gym, async () => {
    const list = await h.call(packages.getActivePackages, req());
    assert.deepEqual(list.body.data.map((p) => [p.name, p.currency, p.price]), [['Monthly', 'PKR', '24'], ['PT x5', 'PKR', '79']]);

    const order = await h.call(orders.assignPackageToUser, req({
      body: { userId: String(ids.member), packageId: String(ids.monthly), paymentMethod: 'cash' }
    }));
    assert.equal(order.statusCode, 201, JSON.stringify(order.body));
    assert.equal(String(order.body.data.payment.currency).toUpperCase(), 'PKR');
    assert.equal(order.body.data.payment.amount, 24);
    assert.equal(String(order.body.data.packageDetails.currency).toUpperCase(), 'PKR');

    assert.equal((await raw('packageorders', ids.paidOrder)).payment.currency, 'GBP');
  });
});

test('a currency sent with a new or edited item is ignored: the gym currency is stored', async () => {
  await h.inGym(gym, async () => {
    const pkg = await Package.create({ name: 'Annual', price: '200', currency: 'EUR', period: 'year', features: ['Everything'] });
    assert.equal((await raw('packages', pkg._id)).currency, 'PKR');

    await Package.findByIdAndUpdate(pkg._id, { currency: 'EUR', name: 'Annual+' });
    const edited = await raw('packages', pkg._id);
    assert.equal(edited.currency, 'PKR');
    assert.equal(edited.name, 'Annual+');

    const created = await h.call(pos.createProduct, req({ body: { name: 'Towel', price: 2, currency: 'EUR' } }));
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.currency, 'PKR');

    const coupon = await Coupon.create({ code: 'TENOFF', type: 'amount', value: 10, currency: 'EUR' });
    assert.equal((await raw('gym_coupons', coupon._id)).currency, 'PKR');
  });
});

test('a new sale or payslip with no currency given is in the gym currency, not a model default', async () => {
  await h.inGym(gym, async () => {
    const sale = await Sale.create({ receiptNumber: 'R-NEW-1', items: [], total: 5, status: 'paid', paymentMethod: 'cash' });
    assert.equal(sale.currency, 'PKR');
    const Payslip = h.src('models/payslipModel');
    const slip = await Payslip.create({ number: 'PS-1', staffId: ids.staff, period: { from: '2026-09-01', to: '2026-09-30' } });
    assert.equal(slip.currency, 'PKR');
  });
});
