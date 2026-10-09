// Who may change a role, and reach into whose account, against a real MongoDB.
//
// `roles: manage` used to be a way to become anything: an account holding it
// could add tabs to the role it held itself, or to the member role everyone
// holds. And two actions on other people's accounts -- signing them out
// everywhere, recording (or withdrawing) their fingerprint consent -- had no
// check on whose account it was, so the front desk could do either to the
// owner. Both now hold the line the rest of the account screens hold
// (services/roleGuards.js).

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let gym;
let User;
let Role;
let Fingerprint;
let roles;
let security;
let roleService;
let admin;
let office;
let manager;
let receptionist;
let member;

const test = h.suite(async () => {
  User = h.src('models/user');
  Role = h.src('models/roleModel');
  Fingerprint = h.src('attendance/models/fingerprintModel');
  roles = h.src('controller/roleController');
  security = h.src('controller/securityController');
  roleService = h.src('services/roleService');

  gym = await h.createGym('role-access-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User, Role);
    await roleService.ensureDefaultRoles();
    // An office role that may edit roles, and little else.
    await Role.create({ name: 'Office', slug: 'office', isStaff: true, permissions: { users: 'manage', roles: 'manage', attendance: 'view' } });
    roleService.invalidate();
    const password = await bcrypt.hash('correct-horse-1', 4);
    const make = (firstName, role, extra = {}) =>
      User.create({ firstName, lastName: 'Access', email: `${firstName.toLowerCase()}@role-access.test`, role, password, employment: { isStaff: role !== 'user' }, ...extra });
    admin = await make('Ada', 'admin');
    office = await make('Olga', 'office');
    manager = await make('Max', 'manager');
    receptionist = await make('Rae', 'receptionist');
    member = await make('Mia', 'user');
  });
});

const inGym = (fn) => h.inGym(gym, fn);
const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });
const roleBySlug = (slug) => inGym(() => Role.findOne({ slug }));
const update = (actor, slug, body) => inGym(async () => h.call(roles.update, { ...as(actor), params: { id: String((await Role.findOne({ slug }))._id) }, body }));
const create = (actor, body) => inGym(() => h.call(roles.create, { ...as(actor), body }));
const levelOf = async (slug, tab) => (await roleBySlug(slug)).permissions.get(tab) || 'none';

test('an account with roles: manage cannot widen the role it holds', async () => {
  const res = await update(office, 'office', { permissions: { users: 'manage', roles: 'manage', attendance: 'view', settings: 'manage', accounts: 'manage' } });
  assert.equal(res.statusCode, 403, JSON.stringify(res.body));
  assert.match(res.body.message, /role you hold yourself/);
  assert.equal(await levelOf('office', 'settings'), 'none');

  // Not even to rename it: the role you hold is an administrator's to change.
  assert.equal((await update(office, 'office', { name: 'Head Office' })).statusCode, 403);
  assert.equal((await roleBySlug('office')).name, 'Office');
});

test('nor give another role, new or old, access it does not hold itself', async () => {
  const made = await create(office, { name: 'Shadow Admin', permissions: { users: 'manage', settings: 'manage' } });
  assert.equal(made.statusCode, 403, JSON.stringify(made.body));
  assert.match(made.body.message, /more access than your own \(Settings\)/);
  assert.equal(await roleBySlug('shadow-admin'), null);

  // A level above its own on a tab it does hold counts too.
  const raised = await create(office, { name: 'Door', permissions: { attendance: 'manage' } });
  assert.equal(raised.statusCode, 403, JSON.stringify(raised.body));

  // Within its own reach it works as before.
  const ok = await create(office, { name: 'Door', permissions: { attendance: 'view', users: 'view' } });
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.role.permissions.attendance, 'view');
  const edited = await update(office, 'door', { permissions: { attendance: 'view', users: 'manage' } });
  assert.equal(edited.statusCode, 200, JSON.stringify(edited.body));
  const widened = await update(office, 'door', { permissions: { attendance: 'view', users: 'manage', reports: 'view' } });
  assert.equal(widened.statusCode, 403, JSON.stringify(widened.body));
  assert.equal(await levelOf('door', 'reports'), 'none');
});

test('a role that reaches further than its own is an administrator\'s to change', async () => {
  // Narrowing the manager role would demote every manager.
  const narrowed = await update(office, 'manager', { permissions: {} });
  assert.equal(narrowed.statusCode, 403, JSON.stringify(narrowed.body));
  assert.match(narrowed.body.message, /This role has more access than yours/);
  assert.equal(await levelOf('manager', 'staff'), 'manage');

  const adminRole = await update(office, 'admin', { name: 'Not the boss' });
  assert.equal(adminRole.statusCode, 403);
  assert.match(adminRole.body.message, /Only an administrator/);

  // An administrator changes any of them, their own name included.
  assert.equal((await update(admin, 'manager', { permissions: { ...Object.fromEntries((await roleBySlug('manager')).permissions), audit: 'view' } })).statusCode, 200);
  assert.equal((await update(admin, 'office', { description: 'Edits roles beneath it' })).statusCode, 200);
  assert.equal((await update(admin, 'admin', { description: 'Everything' })).statusCode, 200);
  assert.equal(await levelOf('admin', 'settings'), 'manage');
});

test('the member role holds no tabs, whoever asks, and the system roles cannot be made again', async () => {
  for (const actor of [office, admin]) {
    const res = await update(actor, 'user', { description: 'A gym member.', permissions: { users: 'manage', dashboard: 'view' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.role.permissions.users, 'none');
    assert.equal(res.body.role.permissions.dashboard, 'none');
  }
  assert.equal(await levelOf('user', 'users'), 'none');

  for (const slug of ['admin', 'user']) {
    const res = await create(admin, { name: 'Again', slug, permissions: {} });
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  }
});

test('a member role that was given tabs before the editor refused them grants nothing, saved again or not', async () => {
  // As a gym's database may still hold it: written straight to the document.
  await inGym(async () => {
    await Role.collection.updateOne({ slug: 'user' }, { $set: { permissions: { users: 'manage', dashboard: 'view', accounts: 'manage' } } });
    roleService.invalidate();
  });
  try {
    assert.equal(await levelOf('user', 'users'), 'manage', 'the stored document still says so');
    await inGym(async () => {
      const held = await roleService.permissionsFor('user');
      assert.deepEqual([...new Set(Object.values(held))], ['none']);
      for (const [tab, level] of [['users', 'view'], ['users', 'manage'], ['dashboard', 'view'], ['accounts', 'manage']]) {
        assert.equal(await roleService.can('user', tab, level), false, `${tab}: ${level}`);
      }
      // A staff role is still read from its document.
      assert.equal(await roleService.can('office', 'users', 'manage'), true);
    });
    // And the Roles screen shows what is true, not what is stored.
    const listed = await inGym(() => h.call(roles.list, as(admin)));
    assert.equal(listed.statusCode, 200, JSON.stringify(listed.body));
    const shown = listed.body.roles.find((role) => role.slug === 'user');
    assert.deepEqual([...new Set(Object.values(shown.permissions))], ['none']);
  } finally {
    await inGym(async () => {
      await Role.collection.updateOne({ slug: 'user' }, { $set: { permissions: {} } });
      roleService.invalidate();
    });
  }
});

// ---- reaching into another account ----------------------------------------

const signOut = (actor, target) => inGym(() => h.call(security.forceLogout, { ...as(actor), params: { id: String(target._id) } }));
const consent = (actor, target, biometric) => inGym(() => h.call(security.recordConsent, { ...as(actor), params: { id: String(target._id) }, body: { biometric } }));
const versionOf = async (target) => (await inGym(() => User.findById(target._id).select('tokenVersion').lean())).tokenVersion || 0;

test('the front desk cannot sign an administrator or a manager out everywhere', async () => {
  for (const [target, reason] of [[admin, /Only an administrator can sign out an administrator/], [manager, /more access than yours/]]) {
    const before = await versionOf(target);
    const res = await signOut(receptionist, target);
    assert.equal(res.statusCode, 403, JSON.stringify(res.body));
    assert.match(res.body.message, reason);
    assert.equal(await versionOf(target), before, 'their sessions are untouched');
  }

  // A member, and somebody at their own level, as before.
  const before = await versionOf(member);
  const ok = await signOut(receptionist, member);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(await versionOf(member), before + 1);
  assert.equal((await signOut(manager, receptionist)).statusCode, 200);
  assert.equal((await signOut(admin, manager)).statusCode, 200);
  assert.equal((await signOut(admin, admin)).statusCode, 200);
});

test('nor record or withdraw their fingerprint consent, which would delete their fingerprints', async () => {
  await inGym(async () => {
    await User.updateOne({ _id: admin._id }, { $set: { 'consents.biometric': { given: true, at: new Date(), source: 'portal' } } });
    await Fingerprint.collection.insertOne({ personType: 'staff', personId: admin._id, fingerIndex: 1, isActive: true });
  });

  const refused = await consent(receptionist, admin, false);
  assert.equal(refused.statusCode, 403, JSON.stringify(refused.body));
  assert.match(refused.body.message, /Only an administrator can record consent for an administrator/);
  await inGym(async () => {
    assert.equal((await User.findById(admin._id).lean()).consents.biometric.given, true);
    assert.equal(await Fingerprint.collection.countDocuments({ personId: admin._id }), 1, 'the fingerprint is still on file');
  });
  assert.equal((await consent(receptionist, manager, true)).statusCode, 403);

  // For a member at the desk, as before.
  const ok = await consent(receptionist, member, true);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal((await inGym(() => User.findById(member._id).lean())).consents.biometric.given, true);
  assert.equal((await consent(admin, admin, false)).statusCode, 200);
});

test('a member with no email is named in these messages, never "undefined"', async () => {
  const pat = await inGym(() => User.create({ firstName: 'Pat', lastName: 'Phone', phone: '0300 7770001', password: 'x' }));
  const nameless = await inGym(() => User.collection.insertOne({ firstName: '', lastName: '', username: 'walkin482', role: 'user', isActive: true }));

  const out = await signOut(receptionist, pat);
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
  assert.equal(out.body.message, 'Pat Phone has been signed out of every device.');
  assert.equal((await signOut(receptionist, { _id: nameless.insertedId })).body.message, 'walkin482 has been signed out of every device.');

  assert.equal((await consent(receptionist, pat, true)).body.message, 'Biometric consent recorded for Pat Phone.');
  assert.equal((await consent(receptionist, pat, false)).body.message, 'Consent withdrawn for Pat Phone.');
  // An account with an address is still named by it.
  assert.equal((await signOut(receptionist, member)).body.message, 'mia@role-access.test has been signed out of every device.');
});
