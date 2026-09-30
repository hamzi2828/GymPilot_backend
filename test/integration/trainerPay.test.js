// A trainer's pay against a real MongoDB: the salary and commission terms on
// the trainer record (set through the admin form, never shown on the public
// site), the commission a completed PT session earns under them, the payslip
// of a trainer on the payroll, the commission payable to one who is not, and
// the wage bill on the accounts overview.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let Trainer;
let User;
let PtSession;
let trainers;
let pt;
let payroll;
let accounts;
let L;
let member;
let staffUser;

const test = h.suite(async () => {
  Trainer = h.src('gymfolio/models/trainerModel');
  User = h.src('models/user');
  PtSession = h.src('gymfolio/models/ptSessionModel');
  trainers = h.src('gymfolio/controller/trainerController');
  pt = h.src('gymfolio/services/ptService');
  payroll = h.src('services/payrollService');
  accounts = h.src('accounts/controller/accountsController');
  L = h.src('accounts/services/ledger');

  // The gym's default is 10% of a session.
  gym = await h.createGym('trainer-pay-gym', { timezone: 'UTC', currency: 'PKR', settings: { pt: { defaultCommissionPercent: 10 } } });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(Trainer, PtSession);
    member = await User.create({ firstName: 'Mo', lastName: 'Member', email: 'mo@trainerpay.test' });
    staffUser = await User.create({
      firstName: 'Sara',
      lastName: 'Staff',
      email: 'sara@trainerpay.test',
      role: 'trainer',
      employment: { isStaff: true, jobTitle: 'Coach', payroll: { basis: 'salaried', salary: 30000, currency: 'PKR', cycle: 'monthly' } }
    });
  });
});

// What the admin page's multipart form sends: every value a string.
const form = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)]));

let free; // no staff account, a salary, a fixed commission
let linked; // on the payroll through Sara's account, a percent
let plain; // no staff account, no salary, the gym's default commission

test('the admin form sets a salary and a fixed commission per session', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(trainers.createTrainer, {
      body: form({ name: 'Faris Free', role: 'Boxing coach', salary: '31000', salaryCycle: 'monthly', commissionType: 'amount', commissionValue: '500' })
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    free = res.body.data;
    const stored = await Trainer.findById(free._id).select('+salary +salaryCycle').lean();
    assert.equal(stored.salary, 31000);
    assert.equal(stored.salaryCycle, 'monthly');
    assert.equal(stored.commissionType, 'amount');
    assert.equal(stored.commissionValue, 500);
    assert.equal(stored.commissionPercent, null);

    const second = await h.call(trainers.createTrainer, {
      body: form({ name: 'Lina Linked', role: 'Coach', userId: String(staffUser._id), commissionType: 'percent', commissionValue: '15' })
    });
    assert.equal(second.statusCode, 201, JSON.stringify(second.body));
    linked = second.body.data;
    const third = await h.call(trainers.createTrainer, { body: form({ name: 'Paul Plain', role: 'Coach' }) });
    plain = third.body.data;
    const storedPlain = await Trainer.findById(plain._id).select('+salary').lean();
    assert.equal(storedPlain.salary, null, 'blank is "not set", not 0');
    assert.equal(storedPlain.commissionType, null);
  });
});

test('a percent keeps the older commissionPercent in step; a form that sends nothing keeps the terms', async () => {
  await h.inGym(gym, async () => {
    let stored = await Trainer.findById(linked._id).lean();
    assert.equal(stored.commissionPercent, 15);

    const res = await h.call(trainers.updateTrainer, { params: { id: linked._id }, body: form({ bio: 'Strength and conditioning' }) });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    stored = await Trainer.findById(linked._id).select('+salary').lean();
    assert.equal(stored.commissionType, 'percent');
    assert.equal(stored.commissionValue, 15);

    const zero = await h.call(trainers.updateTrainer, { params: { id: plain._id }, body: form({ salary: '0' }) });
    assert.equal(zero.statusCode, 200, JSON.stringify(zero.body));
    assert.equal((await Trainer.findById(plain._id).select('+salary').lean()).salary, 0, '0 = commission only');
    await h.call(trainers.updateTrainer, { params: { id: plain._id }, body: form({ salary: '' }) });
    assert.equal((await Trainer.findById(plain._id).select('+salary').lean()).salary, null);
  });
});

test('impossible terms are refused', async () => {
  await h.inGym(gym, async () => {
    const over = await h.call(trainers.updateTrainer, { params: { id: plain._id }, body: form({ commissionType: 'percent', commissionValue: '150' }) });
    assert.equal(over.statusCode, 400);
    const blank = await h.call(trainers.updateTrainer, { params: { id: plain._id }, body: form({ commissionType: 'amount', commissionValue: '' }) });
    assert.equal(blank.statusCode, 400);
    const negative = await h.call(trainers.updateTrainer, { params: { id: plain._id }, body: form({ salary: '-5' }) });
    assert.equal(negative.statusCode, 400);
    const stored = await Trainer.findById(plain._id).select('+salary').lean();
    assert.equal(stored.commissionType, null);
    assert.equal(stored.salary, null);
  });
});

test('pay terms never reach the public site; the admin list has them, and opens one by id', async () => {
  await h.inGym(gym, async () => {
    const hidden = ['salary', 'salaryCycle', 'commissionType', 'commissionValue', 'commissionPercent'];
    const toJson = (doc) => JSON.parse(JSON.stringify(doc));

    const active = toJson((await h.call(trainers.getActiveTrainers, { query: {} })).body.data);
    const bySlug = toJson((await h.call(trainers.getTrainerBySlug, { params: { slug: 'faris-free' } })).body.data);
    const byId = toJson((await h.call(trainers.getTrainerById, { params: { id: free._id } })).body.data);
    for (const doc of [...active, bySlug, byId]) {
      for (const field of hidden) assert.ok(!(field in doc), `${field} is public on ${doc.name}`);
    }

    const admin = await h.call(trainers.getAllTrainers, { query: { id: String(free._id) } });
    assert.equal(admin.statusCode, 200, JSON.stringify(admin.body));
    const [one] = toJson(admin.body.data);
    assert.equal(admin.body.data.length, 1);
    assert.equal(one.salary, 31000);
    assert.equal(one.commissionType, 'amount');
    assert.equal(one.commissionValue, 500);

    const bad = await h.call(trainers.getAllTrainers, { query: { id: 'nope' } });
    assert.equal(bad.statusCode, 404);
  });
});

let day;

test('a completed session earns the trainer\'s commission: fixed, percent, or the gym\'s default', async () => {
  await h.inGym(gym, async () => {
    day = h.src('attendance/services/timeUtils').dateKey();
    const session = (trainer, startTime, price) =>
      PtSession.create({ trainerId: trainer._id, trainerName: trainer.name, memberId: member._id, memberName: 'Mo Member', date: day, startTime, price, currency: 'PKR' });

    const a = await pt.complete(await session(free, '08:00', 2000));
    assert.deepEqual({ basis: a.commission.basis, percent: a.commission.percent, amount: a.commission.amount }, { basis: 'amount', percent: 0, amount: 500 });
    const a2 = await pt.complete(await session(free, '09:00', 0));
    assert.equal(a2.commission.amount, 500, 'a fixed amount whatever the session was worth');

    const b = await pt.complete(await session(linked, '08:00', 2000));
    assert.deepEqual({ basis: b.commission.basis, percent: b.commission.percent, amount: b.commission.amount }, { basis: 'percent', percent: 15, amount: 300 });
    const b2 = await pt.complete(await session(linked, '09:00', 1000));
    assert.equal(b2.commission.amount, 150);

    const c = await pt.complete(await session(plain, '08:00', 2000));
    assert.deepEqual({ basis: c.commission.basis, percent: c.commission.percent, amount: c.commission.amount }, { basis: 'percent', percent: 10, amount: 200 });
  });
});

test('the PT summary says who is paid on a payslip and whose commission is payable by hand', async () => {
  await h.inGym(gym, async () => {
    const rows = await pt.summary(day, day);
    const byName = Object.fromEntries(rows.map((row) => [row.trainer_name, row]));
    assert.equal(byName['Faris Free'].commission, 1000);
    assert.equal(byName['Faris Free'].on_payroll, false);
    assert.equal(byName['Faris Free'].paid_by, 'direct');
    assert.deepEqual(byName['Faris Free'].commission_terms, { basis: 'amount', value: 500 });
    assert.equal(byName['Paul Plain'].paid_by, 'direct');
    assert.deepEqual(byName['Paul Plain'].commission_terms, { basis: 'percent', value: 10 });
    assert.equal(byName['Lina Linked'].commission, 450);
    assert.equal(byName['Lina Linked'].on_payroll, true);
    assert.equal(byName['Lina Linked'].paid_by, 'payslip');
  });
});

test('the linked trainer\'s payslip carries the commission the sessions earned', async () => {
  await h.inGym(gym, async () => {
    const person = await User.findById(staffUser._id).select('firstName lastName email employment').lean();
    const slip = await payroll.draftFor(person, L.readRange({ from: day, to: day }));
    assert.equal(slip.ptSessions, 2);
    assert.equal(slip.ptCommission, 450);
    assert.equal(slip.gross, L.round(slip.base + 450));
  });
});

test('the wage bill costs a trainer with no staff account at their own salary', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(accounts.overview, { query: { from: '2026-09-01', to: '2026-09-30' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const p = res.body.payroll;
    const faris = p.people.find((line) => line.id === String(free._id));
    assert.equal(faris.cost, 31000, 'a whole month is the monthly salary');
    assert.equal(faris.trainer, true);
    assert.equal(faris.currency, 'PKR');
    const sara = p.people.find((line) => line.id === String(staffUser._id));
    assert.equal(sara.cost, 30000);
    assert.ok(!p.people.some((line) => line.id === String(linked._id)), 'a linked trainer is paid through the staff account, once');
    assert.equal(p.base_amount, 61000);
    // Paul has no staff account and no salary: counted apart, not costed.
    assert.equal(p.unlinked_trainers, 1);
  });
});
