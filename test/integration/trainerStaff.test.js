// A trainer who is also on the staff, against a real MongoDB. One human held
// in two records -- the Trainer the website shows and the staff User with the
// pay and roster, tied by Trainer.userId -- is ONE person at the desk: listed
// once as the account, fingers filed under the trainer profile counted and
// handed out as the account's, punches for the profile filed under the
// account and judged against the roster (not PT availability), and the Staff
// page and payroll counting visits under either id once. Trainers not linked
// to a live staff account are left exactly as they were. Then the kiosk side
// of the desk API: staff unlock attempts land in the audit trail.
//
// The gym's clock is set to midday (h.middayZone): the roster below is
// 10:00-11:00 and the PT availability 14:00-20:00, so a punch now is "late"
// against the roster and would have been "early" against the availability.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let gym;
let T;
let L;
let User;
let Trainer;
let Attendance;
let Fingerprint;
let AttendanceLog;
let desktop;
let staffController;
let payroll;
let accounts;
let directory;
let operator;
let tom; // the staff account
let tomProfile; // the same person's trainer profile
let una; // a visiting coach: a trainer and nothing else
let monaProfile; // a trainer linked to a member account, not a staff one
const DESK_PASSWORD = 'desk-password-1';
const PLAIN = 'VFJBSU5FUi1TVEFGRi1URU1QTEFURQ==';
const device = { deviceLabel: 'DESK-1', osUser: 'frontdesk', clientApp: 'GymPilotAttendanceDesktop/1.0', ip: '127.0.0.1' };

const test = h.suite(async () => {
  T = h.src('attendance/services/timeUtils');
  L = h.src('accounts/services/ledger');
  User = h.src('models/user');
  Trainer = h.src('gymfolio/models/trainerModel');
  Attendance = h.src('attendance/models/attendanceModel');
  Fingerprint = h.src('attendance/models/fingerprintModel');
  AttendanceLog = h.src('attendance/models/attendanceLogModel');
  desktop = h.src('attendance/controller/desktopAppController');
  staffController = h.src('controller/staffController');
  payroll = h.src('services/payrollService');
  accounts = h.src('accounts/controller/accountsController');
  directory = h.src('attendance/services/peopleDirectory');

  gym = await h.createGym('trainer-staff-gym', { timezone: h.middayZone(), currency: 'GBP' });

  await h.inGym(gym, async () => {
    await h.ensureIndexes(Attendance, User, Trainer, Fingerprint, AttendanceLog);
    await h.src('services/roleService').ensureDefaultRoles();
    const today = T.weekdayNameForKey(T.dateKey());
    const consents = { biometric: { given: true, at: new Date(), source: 'desk', version: '2026-09' } };

    operator = await User.create({
      firstName: 'Desk',
      lastName: 'Operator',
      email: 'desk@trainerstaff.test',
      role: 'admin',
      password: await bcrypt.hash(DESK_PASSWORD, 4),
      allowAttendanceApp: true,
      allowFingerprintEnrollment: true
    });
    tom = await User.create({
      firstName: 'Tom',
      lastName: 'Trainer',
      email: 'tom@trainerstaff.test',
      role: 'trainer',
      staffCode: 'TR-0010',
      consents,
      employment: {
        isStaff: true,
        jobTitle: 'Personal Trainer',
        schedule: [{ day: today, startTime: '10:00', endTime: '11:00' }],
        payroll: { basis: 'hourly', hourlyRate: 20, currency: 'GBP' }
      }
    });
    tomProfile = await Trainer.create({
      name: 'Tom T.',
      role: 'Coach',
      staffCode: 'TR-0011',
      userId: tom._id,
      availability: [{ day: today, startTime: '14:00', endTime: '20:00' }]
    });
    una = await Trainer.create({ name: 'Una Unlinked', role: 'Visiting coach', staffCode: 'TR-0020' });
    const mona = await User.create({ firstName: 'Mona', lastName: 'Member', email: 'mona@trainerstaff.test', memberCode: 'GP-0001' });
    monaProfile = await Trainer.create({ name: 'Mona Coach', role: 'Coach', staffCode: 'TR-0030', userId: mona._id });

    const finger = (personId, fingerIndex) => ({
      personType: 'staff',
      personId,
      fingerIndex,
      template: Fingerprint.encryptTemplate(PLAIN),
      samplesAccepted: 4,
      samplesTotal: 4,
      enrolledByName: 'Front Desk',
      enrolledDevice: 'DESK-1'
    });
    // Tom's fingers were enrolled while he was listed as the trainer.
    await Fingerprint.create([finger(tomProfile._id, 1), finger(tomProfile._id, 6), finger(una._id, 1)]);
  });
});

const asDesk = (extra = {}) => ({ desktopUser: operator, deviceContext: device, ...extra });
const staffIds = (body) => body.staff.map((person) => person.id);

async function people(q = '') {
  const res = await h.call(desktop.people, { body: { q } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

async function deskPunch(body) {
  const res = await h.call(desktop.punch, asDesk({ body }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

// Fire-and-forget audit writes: wait for the row rather than for a timer.
async function logged(filter) {
  for (let i = 0; i < 40; i++) {
    const row = await AttendanceLog.findOne(filter).sort({ createdAt: -1 }).lean();
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

test('the desk lists a trainer who is also on the staff once, as the staff account', async () => {
  await h.inGym(gym, async () => {
    const body = await people();

    assert.ok(staffIds(body).includes(String(tom._id)));
    assert.ok(!staffIds(body).includes(String(tomProfile._id)), 'the trainer profile is not listed as well');
    assert.equal(staffIds(body).filter((id) => id === String(tom._id)).length, 1);
    // Unlinked, or linked to somebody who is not staff: a trainer as before.
    assert.ok(staffIds(body).includes(String(una._id)));
    assert.ok(staffIds(body).includes(String(monaProfile._id)));

    const entry = body.staff.find((person) => person.id === String(tom._id));
    assert.deepEqual(entry, {
      person_type: 'staff',
      id: String(tom._id),
      name: 'Tom Trainer',
      code: 'TR-0010',
      meta: 'Personal Trainer'
    }, 'the wire shape is unchanged: no internal fields go out');

    // Searched by the trainer profile's code, it is still the account.
    const byProfileCode = await people('TR-0011');
    assert.deepEqual(staffIds(byProfileCode), [String(tom._id)]);
  });
});

test('fingers filed under the trainer profile are the account\'s: enrolled on /people, handed out as the account\'s on /templates', async () => {
  await h.inGym(gym, async () => {
    const { enrolled } = await people();
    assert.ok(enrolled.includes(`staff:${tom._id}`));
    assert.ok(!enrolled.includes(`staff:${tomProfile._id}`));
    assert.ok(enrolled.includes(`staff:${una._id}`));

    const res = await h.call(desktop.templates, asDesk());
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const owners = res.body.templates.map((row) => `${row.person_type}:${row.person_id}:${row.finger_index}`).sort();
    assert.deepEqual(owners, [`staff:${tom._id}:1`, `staff:${tom._id}:6`, `staff:${una._id}:1`].sort());
    assert.equal(res.body.templates[0].template, PLAIN);
  });
});

test('who a trainer profile resolves to: the account while it is live staff, else the trainer itself', async () => {
  await h.inGym(gym, async () => {
    const person = await directory.resolvePerson('staff', String(tomProfile._id));
    assert.equal(String(person.id), String(tom._id));
    assert.equal(person.name, 'Tom Trainer');
    assert.equal(person.code, 'TR-0010');
    assert.deepEqual(person.record.availability.map((slot) => slot.startTime), ['10:00'], 'the roster, not PT availability');
    assert.deepEqual(person.aliasIds.map(String), [String(tomProfile._id)]);

    // The website profile switched off: he still works here.
    await Trainer.updateOne({ _id: tomProfile._id }, { $set: { isActive: false } });
    assert.equal(String((await directory.resolvePerson('staff', String(tomProfile._id))).id), String(tom._id));
    await Trainer.updateOne({ _id: tomProfile._id }, { $set: { isActive: true } });

    // No longer on the staff: the trainer profile is a trainer of its own again.
    await User.updateOne({ _id: tom._id }, { $set: { 'employment.isStaff': false } });
    assert.equal(String((await directory.resolvePerson('staff', String(tomProfile._id))).id), String(tomProfile._id));
    await User.updateOne({ _id: tom._id }, { $set: { 'employment.isStaff': true } });

    const mona = await directory.resolvePerson('staff', String(monaProfile._id));
    assert.equal(String(mona.id), String(monaProfile._id));
  });
});

test('a punch for the trainer profile is filed under the account and judged against the roster; either code checks the same person out', async () => {
  await h.inGym(gym, async () => {
    const checkIn = await deskPunch({ person_type: 'staff', person_id: String(tomProfile._id), method: 'fingerprint' });
    assert.equal(checkIn.success, true, checkIn.message);
    assert.equal(checkIn.detail.action, 'check_in');
    assert.equal(checkIn.detail.person_name, 'Tom Trainer');
    assert.equal(checkIn.detail.person_meta, 'Personal Trainer');

    const row = await Attendance.findOne({ personType: 'staff', checkOutAt: null }).sort({ checkInAt: -1 }).lean();
    assert.equal(String(row.personId), String(tom._id));
    assert.equal(row.personCode, 'TR-0010');
    assert.equal(row.schedule.startTime, '10:00');
    assert.equal(row.status, 'late', 'late against the 10:00 roster -- not early against 14:00 PT availability');
    assert.equal(await Attendance.countDocuments({ personId: tomProfile._id }), 0);

    // 45 minutes later, typing the trainer profile's code.
    await Attendance.collection.updateOne({ _id: row._id }, { $set: { checkInAt: h.minutesAgo(45) } });
    const checkOut = await deskPunch({ code: 'TR-0011' });
    assert.equal(checkOut.success, true, checkOut.message);
    assert.equal(checkOut.detail.action, 'check_out');
    const closed = await Attendance.findById(row._id).lean();
    assert.equal(closed.workedMinutes, 45);
  });
});

test('the Staff page counts the pair once: visits under the profile and the account, one row, one person on shift', async () => {
  await h.inGym(gym, async () => {
    const today = T.dateKey();
    const visit = (personId, fields) => ({ personType: 'staff', personId, personName: 'Tom', shiftDate: today, ...fields });
    const latest = h.minutesAgo(5);
    await Attendance.create([
      // Filed under the trainer profile before the desk treated the two as one.
      visit(tomProfile._id, { checkInAt: h.minutesAgo(200), checkOutAt: h.minutesAgo(170), workedMinutes: 30 }),
      visit(tomProfile._id, { checkInAt: h.minutesAgo(20), open: true, openUntil: new Date(Date.now() + 3600000) }),
      visit(tom._id, { checkInAt: latest, open: true, openUntil: new Date(Date.now() + 3600000) })
    ]);

    const res = await h.call(staffController.list, { query: {} });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.staff.map((person) => person.id), [String(tom._id)], 'staff accounts only, the trainer never a row of its own');

    const stats = res.body.staff[0].attendance;
    assert.equal(stats.visits, 4, 'two under the profile, two under the account');
    assert.equal(stats.minutes, 75, '30 under the profile + 45 under the account');
    assert.equal(stats.still_in, true);
    assert.equal(stats.last_seen_label, `${T.dateLabelForKey(today)} · ${T.timeLabel(latest)}`, 'the latest check-in of either');
    assert.equal(res.body.counts.on_shift, 1, 'one person, however many ids are open');

    // Close the two open ones again so payroll below counts finished visits.
    await Attendance.deleteMany({ checkOutAt: null, personId: { $in: [tom._id, tomProfile._id] } });
  });
});

test('payroll pays the pair once, for the hours under both ids', async () => {
  await h.inGym(gym, async () => {
    const day = T.dateKey();
    const person = await User.findById(tom._id).select('firstName lastName email employment').lean();
    const slip = await payroll.draftFor(person, L.readRange({ from: day, to: day }));
    assert.equal(slip.hours, 1.25, '30 + 45 minutes');
    assert.equal(slip.base, 25);

    const res = await h.call(accounts.overview, { query: { from: day, to: day } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const lines = res.body.payroll.people.filter((line) => line.id === String(tom._id));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].hours, 1.3);
    assert.ok(!res.body.payroll.people.some((line) => line.id === String(tomProfile._id)));
  });
});

test('enrolling the account replaces the same finger filed under the trainer profile, whichever id the desk sent', async () => {
  await h.inGym(gym, async () => {
    const enroll = async (personId, fingerIndex) => {
      const res = await h.call(
        desktop.enroll,
        asDesk({ body: { person_type: 'staff', person_id: String(personId), finger_index: fingerIndex, template: PLAIN, samples_accepted: 4, samples_total: 4 } })
      );
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.person.id, String(tom._id));
      return res.body;
    };

    await enroll(tom._id, 1);
    // A desk still holding the old list sends the trainer profile's id.
    await enroll(tomProfile._id, 6);

    assert.equal(await Fingerprint.countDocuments({ personId: tomProfile._id }), 0, 'nothing left under the trainer profile');
    const mine = await Fingerprint.find({ personId: tom._id }).select('personType fingerIndex').lean();
    assert.deepEqual(mine.map((row) => `${row.personType}:${row.fingerIndex}`).sort(), ['staff:1', 'staff:6']);
    assert.equal(await Fingerprint.countDocuments({ personId: una._id }), 1, 'nobody else\'s fingers touched');
  });
});

test('staff unlock attempts at a kiosk are audit-logged, refused and granted', async () => {
  await h.inGym(gym, async () => {
    const kiosk = {
      desktopToken: { _id: new h.state.mongoose.Types.ObjectId() },
      deviceContext: { ...device, deviceLabel: 'Web kiosk', clientApp: 'GymPilotKiosk/1.0' }
    };
    const account = await User.findById(operator._id).select('-password');

    const wrong = await h.call(desktop.unlock, { ...kiosk, desktopUser: account, body: { password: 'not-it' } });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.body.code, 'WRONG_PASSWORD');
    const denied = await logged({ event: 'staff_unlock_denied' });
    assert.ok(denied, 'the refusal is in the audit trail');
    assert.equal(denied.success, false);
    assert.equal(String(denied.userId), String(operator._id));
    assert.equal(denied.device, 'Web kiosk');
    assert.equal(denied.clientApp, 'GymPilotKiosk/1.0');
    assert.match(denied.message, /wrong password/i);
    assert.ok(!JSON.stringify(denied).includes('not-it'), 'never the password itself');

    const right = await h.call(desktop.unlock, { ...kiosk, desktopUser: account, body: { password: DESK_PASSWORD } });
    assert.equal(right.statusCode, 200, JSON.stringify(right.body));
    assert.ok(right.body.unlock);
    const granted = await logged({ event: 'staff_unlock' });
    assert.ok(granted, 'the grant is in the audit trail');
    assert.equal(granted.success, true);
    assert.ok(!JSON.stringify(granted).includes(right.body.unlock), 'never the grant itself');
  });
});

test('a visit still open under the trainer profile from before the switchover is checked out, not doubled', async () => {
  await h.inGym(gym, async () => {
    await Attendance.deleteMany({ checkOutAt: null, personId: { $in: [tom._id, tomProfile._id] } });
    // Checked in an hour ago, filed under the trainer profile's own id the
    // way the desk filed it before the two records were one person.
    const checkInAt = new Date(Date.now() - 60 * 60 * 1000);
    const old = await Attendance.create({
      personType: 'staff',
      personId: tomProfile._id,
      personName: 'Tom Trainer',
      shiftDate: T.dateKey(checkInAt),
      checkInAt,
      open: true
    });

    const res = await deskPunch({ person_type: 'staff', person_id: String(tom._id), method: 'fingerprint' });
    assert.equal(res.success, true, res.message);
    assert.equal(res.detail.action, 'check_out', 'the account closes the visit open under its profile');

    const closed = await Attendance.findById(old._id).lean();
    assert.ok(closed.checkOutAt, 'the old visit now has a check-out');
    assert.ok(closed.workedMinutes >= 59, 'and the hour it covers');
    assert.equal(await Attendance.countDocuments({ checkOutAt: null, personId: { $in: [tom._id, tomProfile._id] } }), 0, 'no second visit opened');
  });
});
