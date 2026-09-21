// The admin panel's fingerprint tool, without a database: which finger a
// removal is about, how rows are grouped per person and checked for
// readability (the template itself never leaves the handler), who owns each
// group, and that a removal deletes fingerprints and nothing else -- consent
// included. The same handlers run against a real MongoDB, through the real
// routers, in test/integration/fingerprints.test.js.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const Fingerprint = require('../../src/attendance/models/fingerprintModel');
const User = require('../../src/models/user');
const Trainer = require('../../src/gymfolio/models/trainerModel');
const admin = require('../../src/attendance/controller/fingerprintAdminController');

let gymCounter = 0;
const nextGym = () => {
  gymCounter += 1;
  return {
    _id: `00000000000000000000f${String(gymCounter).padStart(3, '0')}`,
    slug: `unit-fingerprints-${gymCounter}`,
    database: { name: `gympilot_unit_fingerprints_${gymCounter}` },
    domains: [],
    locale: { timezone: 'UTC' }
  };
};

const MEMBER = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const TRAINER = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const STAFF_USER = 'ccccccccccccccccccccccc3';
const GONE = 'ddddddddddddddddddddddd4';
const PLAIN = 'U0VDUkVULVRFTVBMQVRF'; // what a desk would send, base64

function chain(rows) {
  const q = { select: () => q, sort: () => q, limit: () => q, lean: async () => rows };
  return q;
}

function respond() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

// Every write a removal might be tempted to make besides the one it should.
function watchForOtherWrites(seen) {
  for (const Model of [User, Trainer]) {
    for (const name of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany', 'deleteOne']) {
      Model[name] = async () => {
        seen.otherWrites.push(name);
        return {};
      };
    }
  }
}

// Rows as they sit on file: a member with a good finger and one encrypted
// under another gym's key, a trainer, a staff account that has left, and a
// finger whose owner was deleted.
async function fileRows(foreignTemplate) {
  const t = (plain) => Fingerprint.encryptTemplate(plain);
  return [
    { personType: 'member', personId: MEMBER, fingerIndex: 6, template: foreignTemplate, updatedAt: new Date('2026-09-02') },
    { personType: 'member', personId: MEMBER, fingerIndex: 1, template: t(PLAIN), enrolledByName: 'Desk One', enrolledDevice: 'DESK-1', createdAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-03') },
    { personType: 'staff', personId: TRAINER, fingerIndex: 2, template: t(PLAIN) },
    { personType: 'staff', personId: STAFF_USER, fingerIndex: 1, template: t(PLAIN) },
    { personType: 'member', personId: GONE, fingerIndex: 3, template: 'not:a:template' }
  ];
}

function stubDirectory(seen) {
  User.find = (filter) => {
    seen.userFilters.push(filter);
    return chain([
      { _id: MEMBER, firstName: 'Mia', lastName: 'Member', email: 'mia@gym.test', phone: '0770 111', memberCode: 'GP-0007', isActive: true },
      { _id: STAFF_USER, firstName: 'Sid', lastName: 'Staff', email: 'sid@gym.test', staffCode: 'TR-0009', isActive: true, employment: { isStaff: false } }
    ]);
  };
  Trainer.find = (filter) => {
    seen.trainerFilters.push(filter);
    return chain([{ _id: TRAINER, name: 'Tara Trainer', email: 'tara@gym.test', staffCode: 'TR-0004', isActive: true }]);
  };
}

async function foreignTemplate() {
  return runWithTenant(nextGym(), async () => Fingerprint.encryptTemplate(PLAIN));
}

test('the finger a removal is about: none means all, 1-10 means one, anything else is refused', () => {
  assert.deepEqual(admin.readFinger(undefined), { index: null });
  assert.deepEqual(admin.readFinger(''), { index: null });
  assert.deepEqual(admin.readFinger('  '), { index: null });
  assert.deepEqual(admin.readFinger('3'), { index: 3 });
  assert.deepEqual(admin.readFinger(10), { index: 10 });
  for (const bad of ['0', '11', '-1', '2.5', 'abc', '1e1', 'all']) {
    assert.equal(admin.readFinger(bad), null, `${bad} is not a finger`);
  }
});

test('finger names follow the desk app\'s FingerNames.All, 1-indexed', () => {
  assert.equal(admin.FINGER_NAMES.length, 10);
  assert.equal(admin.fingerName(1), 'Right Thumb');
  assert.equal(admin.fingerName(5), 'Right Little');
  assert.equal(admin.fingerName(6), 'Left Thumb');
  assert.equal(admin.fingerName(10), 'Left Little');
});

test('rows group per person, in finger order, and a finger that no longer decrypts is marked unreadable', async () => {
  const foreign = await foreignTemplate();
  await runWithTenant(nextGym(), async () => {
    const groups = admin.groupFingers(await fileRows(foreign));
    assert.equal(groups.length, 4);

    const mia = groups.find((g) => g.person_id === MEMBER);
    assert.deepEqual(mia.fingers.map((f) => [f.finger_index, f.readable]), [[1, true], [6, false]]);
    assert.equal(mia.unreadable, 1);
    assert.equal(mia.fingers[0].finger_name, 'Right Thumb');
    assert.equal(mia.fingers[0].enrolled_by, 'Desk One');
    assert.equal(mia.fingers[0].device, 'DESK-1');
    // The last (re)registration, not the first.
    assert.equal(mia.fingers[0].enrolled_at.toISOString(), '2026-09-03T00:00:00.000Z');

    assert.equal(groups.find((g) => g.person_id === GONE).fingers[0].readable, false);
    const text = JSON.stringify(groups);
    assert.ok(!text.includes('template'), 'no template field');
    assert.ok(!text.includes(PLAIN), 'no decrypted template');
  });
});

test('the list names every owner -- member, trainer, staff account, and the deleted -- and says who the desk still matches', async () => {
  const foreign = await foreignTemplate();
  await runWithTenant(nextGym(), async () => {
    const rows = await fileRows(foreign);
    const seen = { userFilters: [], trainerFilters: [] };
    Fingerprint.find = () => chain(rows);
    stubDirectory(seen);

    const res = respond();
    await admin.list({ query: {} }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.summary, { people: 4, fingers: 5, unreadable: 2, departed: 2 });
    assert.deepEqual(res.body.pagination, { page: 1, limit: 25, total: 4, pages: 1 });

    // By name, the owner-less at the end.
    assert.deepEqual(res.body.people.map((p) => p.name), ['Mia Member', 'Sid Staff', 'Tara Trainer', 'Deleted member']);
    const [mia, sid, tara, gone] = res.body.people;
    assert.deepEqual([mia.code, mia.record, mia.status, mia.unreadable], ['GP-0007', 'user', 'active', 1]);
    assert.deepEqual([sid.code, sid.record, sid.status], ['TR-0009', 'user', 'inactive'], 'no longer staff: the desk skips them');
    assert.deepEqual([tara.code, tara.record, tara.status], ['TR-0004', 'trainer', 'active']);
    assert.deepEqual([gone.person_type, gone.record, gone.status, gone.unreadable], ['member', null, 'missing', 1]);

    // Two lookups however many people: staff ids are tried as Trainers and as Users.
    assert.equal(seen.userFilters.length, 1);
    assert.deepEqual(seen.userFilters[0]._id.$in.sort(), [GONE, MEMBER, STAFF_USER, TRAINER].sort());
    assert.deepEqual(seen.trainerFilters[0]._id.$in.sort(), [STAFF_USER, TRAINER].sort());

    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('template') && !text.includes(PLAIN), 'nothing of a template goes out');
    assert.ok(!text.includes('haystack') && !text.includes('mia@gym.test'), 'search fields stay on the server');
  });
});

test('the list searches by name, code, email or phone; filters by type and problem; and pages', async () => {
  const foreign = await foreignTemplate();
  await runWithTenant(nextGym(), async () => {
    const rows = await fileRows(foreign);
    Fingerprint.find = () => chain(rows);
    stubDirectory({ userFilters: [], trainerFilters: [] });

    const names = async (query) => {
      const res = respond();
      await admin.list({ query }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      return res.body;
    };

    assert.deepEqual((await names({ q: 'gp-0007' })).people.map((p) => p.name), ['Mia Member']);
    assert.deepEqual((await names({ q: 'TARA@' })).people.map((p) => p.name), ['Tara Trainer']);
    assert.deepEqual((await names({ q: '0770' })).people.map((p) => p.name), ['Mia Member']);
    assert.deepEqual((await names({ q: 'tr-' })).people.map((p) => p.name), ['Sid Staff', 'Tara Trainer']);
    assert.deepEqual((await names({ person_type: 'staff' })).people.map((p) => p.name), ['Sid Staff', 'Tara Trainer']);
    assert.deepEqual((await names({ show: 'unreadable' })).people.map((p) => p.name), ['Mia Member', 'Deleted member']);
    assert.deepEqual((await names({ show: 'departed' })).people.map((p) => p.name), ['Sid Staff', 'Deleted member']);
    assert.deepEqual((await names({ q: 'nobody' })).people, []);

    const second = await names({ limit: '1', page: '2' });
    assert.deepEqual(second.people.map((p) => p.name), ['Sid Staff']);
    assert.deepEqual(second.pagination, { page: 2, limit: 1, total: 4, pages: 4 });
    // The summary is the whole gym's, whatever the filter.
    assert.equal((await names({ q: 'nobody' })).summary.unreadable, 2);
  });
});

test('a removal checks what it was given before it deletes anything', async () => {
  await runWithTenant(nextGym(), async () => {
    let deletes = 0;
    Fingerprint.deleteMany = async () => {
      deletes += 1;
      return { deletedCount: 1 };
    };

    const cases = [
      [{ personType: 'guest', personId: MEMBER }, {}, /person type/],
      [{ personType: 'member', personId: 'nope' }, {}, /person id/],
      [{ personType: 'member', personId: MEMBER, finger: '11' }, {}, /finger from 1 to 10/],
      [{ personType: 'member', personId: MEMBER }, { finger: 'thumb' }, /finger from 1 to 10/]
    ];
    for (const [params, query, message] of cases) {
      const res = respond();
      await admin.remove({ params, query }, res);
      assert.equal(res.statusCode, 400, JSON.stringify(params));
      assert.match(res.body.message, message);
    }
    assert.equal(deletes, 0);
  });
});

test('removing one finger deletes that finger only, and touches no consent or person record', async () => {
  await runWithTenant(nextGym(), async () => {
    const seen = { deleted: [], counted: [], otherWrites: [], userFilters: [], trainerFilters: [] };
    Fingerprint.deleteMany = async (filter) => {
      seen.deleted.push(filter);
      return { deletedCount: 1 };
    };
    Fingerprint.countDocuments = async (filter) => {
      seen.counted.push(filter);
      return 1;
    };
    stubDirectory(seen);
    watchForOtherWrites(seen);

    // The path form and the query form are the same request.
    for (const req of [
      { params: { personType: 'member', personId: MEMBER, finger: '6' }, query: {} },
      { params: { personType: 'member', personId: MEMBER }, query: { finger: '6' } }
    ]) {
      const res = respond();
      await admin.remove(req, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(res.body.message, "Removed Mia Member's left thumb. Front desks stop matching it at their next refresh.");
      assert.deepEqual(res.body.data, { person_type: 'member', person_id: MEMBER, name: 'Mia Member', finger_index: 6, removed: 1, remaining: 1 });
    }

    for (const filter of seen.deleted) {
      assert.deepEqual(Object.keys(filter).sort(), ['fingerIndex', 'personId', 'personType']);
      assert.equal(filter.personType, 'member');
      assert.equal(String(filter.personId), MEMBER);
      assert.equal(filter.fingerIndex, 6);
    }
    assert.deepEqual(Object.keys(seen.counted[0]).sort(), ['personId', 'personType'], 'what is left, across every finger');
    assert.deepEqual(seen.otherWrites, [], 'fingerprints only: consent and the person are left alone');
  });
});

test('removing every finger works for a trainer and a staff account, and says so when there was nothing to remove', async () => {
  await runWithTenant(nextGym(), async () => {
    const seen = { deleted: [], otherWrites: [], userFilters: [], trainerFilters: [] };
    let onFile = 2;
    Fingerprint.deleteMany = async (filter) => {
      seen.deleted.push(filter);
      const removed = onFile;
      onFile = 0;
      return { deletedCount: removed };
    };
    Fingerprint.countDocuments = async () => onFile;
    stubDirectory(seen);
    watchForOtherWrites(seen);

    const trainer = respond();
    await admin.remove({ params: { personType: 'staff', personId: TRAINER }, query: {} }, trainer);
    assert.equal(trainer.statusCode, 200, JSON.stringify(trainer.body));
    assert.equal(trainer.body.message, 'Removed 2 fingerprints from Tara Trainer. Front desks stop matching them at their next refresh.');
    assert.deepEqual(Object.keys(seen.deleted[0]).sort(), ['personId', 'personType'], 'no finger: every finger');
    assert.equal(trainer.body.data.remaining, 0);

    const again = respond();
    await admin.remove({ params: { personType: 'staff', personId: TRAINER }, query: {} }, again);
    assert.equal(again.statusCode, 404);
    assert.equal(again.body.message, 'No fingerprints are on file for this person.');

    onFile = 1;
    const staff = respond();
    await admin.remove({ params: { personType: 'staff', personId: STAFF_USER }, query: {} }, staff);
    assert.equal(staff.statusCode, 200, JSON.stringify(staff.body));
    assert.equal(staff.body.data.name, 'Sid Staff');
    assert.match(staff.body.message, /^Removed 1 fingerprint from Sid Staff\. .* matching it /);

    const missing = respond();
    await admin.remove({ params: { personType: 'member', personId: MEMBER, finger: '4' }, query: {} }, missing);
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.message, 'No right ring is on file for this person.');
    assert.deepEqual(seen.otherWrites, []);
  });
});

test('the routes: listing needs attendance view, removing needs attendance manage, both behind auth', async () => {
  const router = require('../../src/routes/allRoutes');
  const Role = require('../../src/models/roleModel');
  const { DEFAULT_ROLES, invalidate } = require('../../src/services/roleService');
  const routes = router.stack
    .filter((layer) => layer.route && String(layer.route.path).startsWith('/api/attendance/fingerprints'))
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods),
      handlers: layer.route.stack.map((entry) => entry.handle)
    }));

  assert.deepEqual(
    routes.map((r) => `${r.methods.join(',')} ${r.path}`),
    [
      'get /api/attendance/fingerprints',
      'delete /api/attendance/fingerprints/:personType/:personId',
      'delete /api/attendance/fingerprints/:personType/:personId/:finger'
    ]
  );
  const auth = require('../../src/middleware/auth');
  for (const route of routes) {
    assert.equal(route.handlers[0], auth, `${route.path}: auth first`);
    assert.equal(route.handlers[1].name, 'permissionGate', `${route.path}: then the permission gate`);
    assert.equal(route.handlers.length, 3);
  }
  assert.equal(routes[0].handlers[2], admin.list);
  assert.equal(routes[1].handlers[2], admin.remove);
  assert.equal(routes[2].handlers[2], admin.remove);

  // The gates themselves, against the shipped roles: a trainer holds
  // attendance at view, a receptionist at manage, a cleaner not at all.
  await runWithTenant(nextGym(), async () => {
    Role.find = () => ({ lean: async () => DEFAULT_ROLES.map((role) => ({ ...role, isActive: true })) });
    invalidate();
    const passes = async (route, role, method) => {
      User.findById = () => chain({ _id: 'u1', role, isActive: true });
      const res = respond();
      res.on = () => {};
      let passed = false;
      await route.handlers[1]({ method, user: { id: 'u1', role }, headers: {}, originalUrl: route.path }, res, () => {
        passed = true;
      });
      assert.equal(passed, res.statusCode === 200, `${role} ${method}: passed and status agree`);
      return passed;
    };

    assert.equal(await passes(routes[0], 'trainer', 'GET'), true, 'view lists');
    assert.equal(await passes(routes[1], 'trainer', 'DELETE'), false, 'view cannot remove');
    assert.equal(await passes(routes[2], 'trainer', 'DELETE'), false, 'view cannot remove one finger');
    assert.equal(await passes(routes[1], 'receptionist', 'DELETE'), true, 'manage removes');
    assert.equal(await passes(routes[2], 'receptionist', 'DELETE'), true);
    assert.equal(await passes(routes[0], 'cleaner', 'GET'), false, 'no attendance tab: not even the list');
  });
});
