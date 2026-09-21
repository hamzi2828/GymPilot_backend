// Payroll against a real MongoDB: the payslip `live` partial unique index is
// actually built and actually refuses a second live payslip; generating twice
// (one after the other, or at the same moment) never drafts a duplicate; a
// whole month costs exactly the monthly salary; paying twice files one wage.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let L;
let User;
let Payslip;
let Attendance;
let LeaveRequest;
let Expense;
let payroll;
let hr;
let accounts;
let admin;
let salaried;
let hourly;

const test = h.suite(async () => {
  L = h.src('accounts/services/ledger');
  User = h.src('models/user');
  Payslip = h.src('models/payslipModel');
  Attendance = h.src('attendance/models/attendanceModel');
  LeaveRequest = h.src('models/leaveRequestModel');
  Expense = h.src('accounts/models/expenseModel');
  payroll = h.src('services/payrollService');
  hr = h.src('controller/hrController');
  accounts = h.src('accounts/controller/accountsController');

  gym = await h.createGym('payroll-gym', { timezone: 'UTC', currency: 'GBP' });

  await h.inGym(gym, async () => {
    await h.ensureIndexes(Payslip, Expense);
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@payroll.test', role: 'admin' });
    salaried = await User.create({
      firstName: 'Sal',
      lastName: 'Aried',
      email: 'sal@payroll.test',
      role: 'receptionist',
      employment: { isStaff: true, jobTitle: 'Reception', payroll: { basis: 'salaried', salary: 3100, currency: 'GBP', cycle: 'monthly' } }
    });
    hourly = await User.create({
      firstName: 'Hour',
      lastName: 'Ly',
      email: 'hour@payroll.test',
      role: 'cleaner',
      employment: { isStaff: true, jobTitle: 'Cleaner', payroll: { basis: 'hourly', hourlyRate: 10, currency: 'GBP' } }
    });

    // Ten hours worked in August, two shifts.
    await Attendance.collection.insertMany([
      { personType: 'staff', personId: hourly._id, personName: 'Hour Ly', shiftDate: '2026-08-05', checkInAt: new Date('2026-08-05T09:00:00Z'), checkOutAt: new Date('2026-08-05T15:00:00Z'), workedMinutes: 360, autoClosed: false },
      { personType: 'staff', personId: hourly._id, personName: 'Hour Ly', shiftDate: '2026-08-06', checkInAt: new Date('2026-08-06T09:00:00Z'), checkOutAt: new Date('2026-08-06T13:00:00Z'), workedMinutes: 240, autoClosed: false }
    ]);

    // Two days of approved unpaid leave in August for the salaried one.
    await LeaveRequest.create({ staffId: salaried._id, staffName: 'Sal Aried', type: 'unpaid', from: '2026-08-10', to: '2026-08-11', days: 2, status: 'approved', unpaid: true });
  });
});

const august = () => L.readRange({ from: '2026-08-01', to: '2026-08-31' });

test('the `live` partial unique index is built on the payslip collection', async () => {
  await h.inGym(gym, async () => {
    const indexes = await Payslip.collection.indexes();
    const index = indexes.find((i) => JSON.stringify(i.key) === JSON.stringify({ staffId: 1, 'period.from': 1, 'period.to': 1 }));
    assert.ok(index, `index missing; have ${indexes.map((i) => i.name).join(', ')}`);
    assert.equal(index.unique, true);
    assert.deepEqual(index.partialFilterExpression, { live: true });
  });
});

test('the index refuses a second live payslip for the same person and period, but not a void one', async () => {
  await h.inGym(gym, async () => {
    const period = { from: '2025-01-01', to: '2025-01-31', label: 'Jan 2025' };
    await Payslip.create({ number: 'DUP-1', staffId: salaried._id, period });
    await assert.rejects(Payslip.create({ number: 'DUP-2', staffId: salaried._id, period }), (error) => error.code === 11000);
    // A voided one is not live, so it may sit beside the live one.
    const voided = await Payslip.create({ number: 'DUP-3', staffId: salaried._id, period, status: 'void' });
    assert.equal(voided.live, false);
    // A conditional update to void keeps the flag in step too.
    await Payslip.updateOne({ number: 'DUP-1' }, { $set: { status: 'void' } });
    const first = await Payslip.findOne({ number: 'DUP-1' }).lean();
    assert.equal(first.live, false);
    await Payslip.create({ number: 'DUP-4', staffId: salaried._id, period });
  });
});

test('generating a month drafts one payslip each: a whole month is exactly the monthly salary', async () => {
  await h.inGym(gym, async () => {
    const result = await payroll.generate(august(), { createdBy: admin._id });
    assert.equal(result.created.length, 2);
    assert.equal(result.refreshed.length, 0);

    const sal = await Payslip.findOne({ staffId: salaried._id, 'period.from': '2026-08-01' }).lean();
    assert.equal(sal.base, 3100, 'a 31-day month of a 3100 monthly salary');
    assert.equal(sal.unpaidLeaveDays, 2);
    assert.equal(sal.unpaidLeaveDeduction, 200, 'each August day is 3100 / 31');
    assert.equal(sal.net, 2900);
    assert.equal(sal.currency, 'GBP');
    assert.equal(sal.live, true);
    assert.match(sal.number, /^PAY-2026-\d{4}$/);

    const hr1 = await Payslip.findOne({ staffId: hourly._id, 'period.from': '2026-08-01' }).lean();
    assert.equal(hr1.basis, 'hourly');
    assert.equal(hr1.hours, 10);
    assert.equal(hr1.base, 100);
  });
});

test('generating the same month again refreshes the drafts and adds none', async () => {
  await h.inGym(gym, async () => {
    const result = await payroll.generate(august(), { createdBy: admin._id });
    assert.equal(result.created.length, 0);
    assert.equal(result.refreshed.length, 2);
    assert.equal(await Payslip.countDocuments({ 'period.from': '2026-08-01', 'period.to': '2026-08-31' }), 2);
  });
});

test('"Generate" pressed twice at once still drafts one payslip per person', async () => {
  await h.inGym(gym, async () => {
    const july = L.readRange({ from: '2026-07-01', to: '2026-07-31' });
    const [a, b] = await Promise.all([payroll.generate(july), payroll.generate(july)]);
    const rows = await Payslip.find({ 'period.from': '2026-07-01', 'period.to': '2026-07-31' }).lean();
    assert.equal(rows.length, 2, `two runs made ${rows.length} payslips (${a.created.length} + ${b.created.length} created)`);
    assert.equal(new Set(rows.map((r) => String(r.staffId))).size, 2);
    assert.equal(a.created.length + b.created.length, 2);
  });
});

test('salaryForDays: February and a 31-day month are each exactly one salary; weekly pro-rates by 7', async () => {
  await h.inGym(gym, async () => {
    assert.equal(L.round(L.salaryForDays(3100, 'monthly', '2026-02-01', '2026-02-28')), 3100);
    assert.equal(L.round(L.salaryForDays(3100, 'monthly', '2026-08-01', '2026-08-31')), 3100);
    assert.equal(L.round(L.salaryForDays(3100, 'monthly', '2026-08-01', '2026-08-15')), 1500);
    assert.equal(L.round(L.salaryForDays(700, 'weekly', '2026-08-01', '2026-08-14')), 1400);

    const feb = await payroll.generate(L.readRange({ from: '2026-02-01', to: '2026-02-28' }));
    const slip = feb.created.find((doc) => String(doc.staffId) === String(salaried._id));
    assert.equal(slip.base, 3100);
  });
});

test('the accounts overview costs the same month the same way', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(accounts.overview, { query: { from: '2026-08-01', to: '2026-08-31' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.payroll.salaried, 3100);
    assert.equal(res.body.payroll.hourly, 100);
    assert.equal(res.body.payroll.hours, 10);
  });
});

test('a voided payslip frees the period for a new draft', async () => {
  await h.inGym(gym, async () => {
    const slip = await Payslip.findOne({ staffId: hourly._id, 'period.from': '2026-08-01', status: 'draft' });
    const res = await h.call(hr.setPayslipStatus, { params: { id: String(slip._id), action: 'void' }, user: { id: String(admin._id) }, roleSlug: 'admin' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal((await Payslip.findById(slip._id).lean()).live, false);

    const result = await payroll.generate(august());
    assert.equal(result.created.length, 1, 'a fresh draft for the voided person');
    assert.equal(await Payslip.countDocuments({ 'period.from': '2026-08-01', live: true }), 2);
  });
});

test('paying a payslip twice at once files one salary expense', async () => {
  await h.inGym(gym, async () => {
    const slip = await Payslip.findOne({ staffId: salaried._id, 'period.from': '2026-08-01' });
    const request = () => h.call(hr.setPayslipStatus, {
      params: { id: String(slip._id), action: 'pay' },
      body: { paymentMethod: 'bank_transfer' },
      user: { id: String(admin._id) },
      roleSlug: 'admin'
    });
    const results = await Promise.all([request(), request()]);
    const codes = results.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [200, 409], JSON.stringify(results.map((r) => r.body)));

    const expenses = await Expense.find({ staffId: salaried._id, category: 'salaries' }).lean();
    assert.equal(expenses.length, 1);
    assert.equal(expenses[0].amount, 2900);
    const paid = await Payslip.findById(slip._id).lean();
    assert.equal(paid.status, 'paid');
    assert.equal(String(paid.expenseId), String(expenses[0]._id));
  });
});
