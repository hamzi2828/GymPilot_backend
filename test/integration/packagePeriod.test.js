// A package is only saved when its period says how long it lasts.
//
// A one-off package takes its length from the period label. One the server
// could not read ("Lifetime", "Custom") used to be sold as 30 days whatever
// it cost; now the Packages screen is told when it is saved. Packages stored
// before that keep working, and keep saving while their period is left alone.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let Package;
let controller;

const test = h.suite(async () => {
  Package = h.src('gymfolio/models/packageModel');
  controller = h.src('gymfolio/controller/packageController');
  gym = await h.createGym('pkg-period-gym', { currency: 'GBP' });
});

const base = { name: 'Plan', price: '400', currency: 'GBP', features: ['Gym floor'] };
const create = (body) => h.call(controller.createPackage, { body: { ...base, ...body } });
const update = (pkg, body) => h.call(controller.updatePackage, { params: { id: String(pkg._id) }, body });

test('creating: a period that names a length is saved, one that names none is refused with what to do', async () => {
  await h.inGym(gym, async () => {
    for (const period of ['Annual', 'Quarterly', 'Half year', 'Fortnight', '3 months']) {
      const res = await create({ name: `Plan ${period}`, period });
      assert.equal(res.statusCode, 201, `${period}: ${JSON.stringify(res.body)}`);
    }

    const refused = await create({ name: 'For ever', period: 'Lifetime' });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.body.code, 'PERIOD_NOT_UNDERSTOOD');
    assert.match(refused.body.message, /The period "Lifetime" does not say how long this package lasts/);
    assert.match(refused.body.message, /set how many days it is valid for/);
    assert.equal(await Package.countDocuments({ name: 'For ever' }), 0);

    // The days, or a recurring interval, say it instead.
    assert.equal((await create({ name: 'For ever (days)', period: 'Lifetime', durationDays: 3650 })).statusCode, 201);
    assert.equal((await create({ name: 'Rolling', period: 'Custom', billing: { mode: 'recurring', interval: 'month' } })).statusCode, 201);
  });
});

test('updating: checked as the package will be once saved', async () => {
  await h.inGym(gym, async () => {
    const pkg = await Package.create({ ...base, name: 'Yearly', period: 'year' });
    const refused = await update(pkg, { period: 'Unlimited' });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.body.code, 'PERIOD_NOT_UNDERSTOOD');
    assert.equal((await Package.findById(pkg._id).lean()).period, 'year');

    assert.equal((await update(pkg, { period: 'Annual' })).statusCode, 200);

    // Taking the days off a package whose label cannot stand in for them.
    const pack = await Package.create({ ...base, name: 'Pack', period: '10 sessions', durationDays: 60, sessions: 10, kind: 'session_pack' });
    assert.equal((await update(pack, { price: '450' })).statusCode, 200);
    assert.equal((await update(pack, { durationDays: 0 })).statusCode, 400);
    assert.equal((await Package.findById(pack._id).lean()).durationDays, 60);
  });
});

test('a package stored before periods were checked still saves while its period is left as it was', async () => {
  await h.inGym(gym, async () => {
    const old = await Package.create({ ...base, name: 'Corporate', period: 'B2B Deal' });
    const priced = await update(old, { price: '500', period: 'B2B Deal' });
    assert.equal(priced.statusCode, 200, JSON.stringify(priced.body));
    assert.equal(priced.body.data.price, '500');

    // Changed to another label that names nothing: told, like a new one.
    assert.equal((await update(old, { period: 'Custom' })).statusCode, 400);
    // Fixed.
    assert.equal((await update(old, { period: 'Quarterly' })).statusCode, 200);
  });
});

test('"12 classes per month" is refused, not saved as a twelve-month package', async () => {
  await h.inGym(gym, async () => {
    const refused = await create({ name: 'Twelve a month', period: '12 classes per month' });
    assert.equal(refused.statusCode, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'PERIOD_NOT_UNDERSTOOD');
    assert.match(refused.body.message, /^The period "12 classes per month" starts with 12, which is not how long this package lasts/);
    assert.equal(await Package.countDocuments({ name: 'Twelve a month' }), 0);

    // Said the way it is meant, it saves.
    const saved = await create({ name: 'Twelve a month', period: 'month', kind: 'session_pack', sessions: 12 });
    assert.equal(saved.statusCode, 201, JSON.stringify(saved.body));
    assert.equal((await create({ name: 'Three months', period: '3 x month' })).statusCode, 201);
  });
});
