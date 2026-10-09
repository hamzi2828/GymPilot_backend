// Cancelling a personal training session against a real MongoDB: two
// cancels of one session arriving together (a double tap, the member and the
// desk) cancel it once and give the pack credit back once.
//
// The gym's clock is set to midday and the sessions are days away, so the
// late-cancel window (12 hours by default) does not interfere except in the
// test that is about it.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let T;
let User;
let PtSession;
let PackageOrder;
let ptController;
let member;
let pack;
let slot = 0;

const test = h.suite(async () => {
  T = h.src('attendance/services/timeUtils');
  User = h.src('models/user');
  PtSession = h.src('gymfolio/models/ptSessionModel');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  ptController = h.src('gymfolio/controller/ptController');

  gym = await h.createGym('pt-cancel-gym', { timezone: h.middayZone(), currency: 'GBP' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(PtSession, PackageOrder, User);
    member = await User.create({ firstName: 'Pat', lastName: 'Member', email: 'pat@pt-cancel.test' });
    const now = new Date();
    pack = await PackageOrder.create({
      orderNumber: 'PT-PACK-1',
      userId: member._id,
      packageId: new h.state.mongoose.Types.ObjectId(),
      packageDetails: { name: '10 PT sessions', price: '300', currency: 'GBP', period: 'month', kind: 'pt_pack', sessions: 10 },
      customerInfo: { fullName: 'Pat Member', email: member.email },
      payment: { method: 'cash', amount: 300, currency: 'GBP', status: 'paid', paidAt: now },
      subscription: { startDate: now, endDate: new Date(now.getTime() + 60 * 86400000), isActive: true },
      status: 'active',
      // Several used, so a credit handed back twice shows (the count never
      // goes below zero, which would hide it on a pack with one used).
      sessions: { total: 10, used: 5 }
    });
  });
});

const used = async () => (await PackageOrder.findById(pack._id).lean()).sessions.used;

// A session on the pack, `days` from today, as ptService.book writes it.
function session(days) {
  slot += 1;
  return PtSession.create({
    trainerId: new h.state.mongoose.Types.ObjectId(),
    trainerName: 'Coach',
    memberId: member._id,
    memberName: 'Pat Member',
    date: T.shiftDateKey(T.dateKey(), days),
    startTime: `${String(8 + slot).padStart(2, '0')}:00`,
    endTime: `${String(9 + slot).padStart(2, '0')}:00`,
    orderId: pack._id,
    creditUsed: true,
    price: 30,
    currency: 'GBP'
  });
}

const cancel = (id, extra = {}) => h.call(ptController.cancel, { user: { id: String(member._id) }, params: { id: String(id) }, body: {}, ...extra });

test('two cancels of one session: one succeeds and the credit comes back once', async () => {
  await h.inGym(gym, async () => {
    for (let round = 0; round < 3; round++) {
      const s = await session(3);
      const before = await used();
      const results = await Promise.all([cancel(s._id), cancel(s._id)]);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409], JSON.stringify(results.map((r) => r.body)));
      const won = results.find((r) => r.statusCode === 200);
      assert.equal(won.body.data.status, 'cancelled');
      assert.equal(won.body.data.late_cancel, false);
      assert.match(won.body.message, /credit is back on the pack/);
      assert.match(results.find((r) => r.statusCode === 409).body.message, /already cancelled/);
      assert.equal(await used(), before - 1, 'the credit went back once');
      assert.equal((await PtSession.findById(s._id).lean()).status, 'cancelled');
    }
  });
});

test('the member and the desk cancelling together: still one credit back', async () => {
  await h.inGym(gym, async () => {
    const s = await session(3);
    const before = await used();
    const results = await Promise.all([cancel(s._id), cancel(s._id, { isStaffBooking: true })]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409], JSON.stringify(results.map((r) => r.body)));
    assert.equal(await used(), before - 1);
  });
});

test('a late cancel by the member keeps the credit used; the desk cancelling gives it back', async () => {
  await h.inGym(gym, async () => {
    // Later today: inside the 12-hour window.
    const late = await session(0);
    const before = await used();
    const res = await cancel(late._id);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.late_cancel, true);
    assert.match(res.body.message, /late cancellation/);
    assert.equal(await used(), before);

    const desk = await session(0);
    const byDesk = await cancel(desk._id, { isStaffBooking: true });
    assert.equal(byDesk.statusCode, 200, JSON.stringify(byDesk.body));
    assert.equal(byDesk.body.data.late_cancel, false);
    assert.equal(await used(), before - 1);
  });
});
