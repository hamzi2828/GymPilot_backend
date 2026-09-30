// Which accounts must have an email address, against a real MongoDB, at a
// gym that requires two-factor sign-in for its staff. The code is emailed,
// so a member without an address is not given a staff role -- from the
// Users tab, the Staff screen or the admin form -- and a staff account made
// before that rule is told at sign-in why it cannot get a code, instead of
// "we could not email your sign-in code" on every attempt.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let User;
let users;
let staff;
let twoFactor;
let admin;
let phoneOnly;
let withEmail;
let legacyStaff;

const PASSWORD = 'correct-horse-1';

const test = h.suite(async () => {
  User = h.src('models/user');
  users = h.src('controller/userController');
  staff = h.src('controller/staffController');
  twoFactor = h.src('services/twoFactorService');

  gym = await h.createGym('account-email-gym', { settings: { twoFactorAuth: true } });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User);
    await h.src('services/roleService').ensureDefaultRoles();
    const password = await bcrypt.hash(PASSWORD, 4);
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@account-email.test', role: 'admin', password, employment: { isStaff: true } });
    phoneOnly = await User.create({ firstName: 'Pat', lastName: 'Phone', phone: '0300 1110001', password });
    withEmail = await User.create({ firstName: 'Eve', lastName: 'Email', email: 'eve@account-email.test', password });
    // Moved onto the staff before the rule existed.
    legacyStaff = await User.create({ firstName: 'Lou', lastName: 'Legacy', phone: '0300 1110002', role: 'receptionist', password, employment: { isStaff: true } });
  });
});

const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });
const bearer = (actor) => `Bearer ${jwt.sign({ id: String(actor._id), email: actor.email, role: actor.role }, process.env.JWT_SECRET)}`;
const setRole = (target, role) =>
  h.inGym(gym, () => h.call(users.updateUserRoleById, { ...as(admin), headers: { authorization: bearer(admin) }, params: { id: String(target._id) }, body: { role } }));
const roleOf = (target) => h.inGym(gym, async () => (await User.findById(target._id).select('role employment.isStaff').lean()));

test('the Users tab will not give a staff role to a member with no email', async () => {
  const refused = await setRole(phoneOnly, 'receptionist');
  assert.equal(refused.statusCode, 409, JSON.stringify(refused.body));
  assert.match(refused.body.message, /no email address/);
  const after = await roleOf(phoneOnly);
  assert.equal(after.role, 'user');
  assert.notEqual(after.employment && after.employment.isStaff, true);

  // Someone with an address is promoted as before.
  const promoted = await setRole(withEmail, 'receptionist');
  assert.equal(promoted.statusCode, 200, JSON.stringify(promoted.body));
  assert.equal((await roleOf(withEmail)).role, 'receptionist');
  assert.equal((await setRole(withEmail, 'user')).statusCode, 200);
});

test('nor will the Staff screen', async () => {
  const refused = await h.inGym(gym, () =>
    h.call(staff.update, { ...as(admin), params: { id: String(phoneOnly._id) }, body: { role: 'receptionist' } })
  );
  assert.equal(refused.statusCode, 409, JSON.stringify(refused.body));
  assert.match(refused.body.message, /no email address/);
  assert.equal((await roleOf(phoneOnly)).role, 'user');

  // A staff account already without one can still be edited; only a new
  // role is held back.
  const edited = await h.inGym(gym, () =>
    h.call(staff.update, { ...as(admin), params: { id: String(legacyStaff._id) }, body: { jobTitle: 'Front desk' } })
  );
  assert.equal(edited.statusCode, 200, JSON.stringify(edited.body));
});

test('nor the admin form, for a new account', async () => {
  const refused = await h.inGym(gym, () =>
    h.call(users.adminCreateUser, { ...as(admin), body: { firstName: 'Nia', lastName: 'Newstaff', phone: '0300 1110003', role: 'receptionist' } })
  );
  assert.equal(refused.statusCode, 400, JSON.stringify(refused.body));
  assert.match(refused.body.message, /email address/);
  assert.equal(await h.inGym(gym, () => User.exists({ firstName: 'Nia' })), null);
});

test('a staff account with no email is told why at sign-in, and no code is sent anywhere', async () => {
  const before = h.calls.emails.length;
  const res = await h.inGym(gym, () => h.call(users.loginUser, { body: { email: legacyStaff.username, password: PASSWORD } }));
  assert.notEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.token, undefined);
  assert.match(JSON.stringify(res.body), /no email address/);
  assert.equal(h.calls.emails.length, before, 'nothing emailed to nobody');

  const stored = await h.inGym(gym, () => User.findById(legacyStaff._id).lean());
  assert.equal(stored.twoFactor && stored.twoFactor.pending && stored.twoFactor.pending.challengeId, null, 'no challenge left waiting for a code');

  const challenge = await h.inGym(gym, () => twoFactor.startChallenge(stored));
  assert.equal(challenge.noEmail, true);
  assert.equal(challenge.emailed, false);
  assert.equal(challenge.challengeId, null);
});

test('taking the staff role away needs no email', async () => {
  const res = await setRole(legacyStaff, 'user');
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal((await roleOf(legacyStaff)).role, 'user');
});

// ---- removing one's own email (PUT /update/user) --------------------------

const updateMe = (actor, body) => h.inGym(gym, () => h.call(users.updateUser, { headers: { authorization: bearer(actor) }, body }));
const storedOf = (actor) => h.rawDb(gym.database.name).collection('users').findOne({ _id: actor._id });

async function account(fields) {
  return h.inGym(gym, async () => User.create({ password: await bcrypt.hash(PASSWORD, 4), ...fields }));
}

test('a member can remove their email, and signs in with their username after', async () => {
  const mia = await account({ firstName: 'Mia', lastName: 'Member', email: 'mia@account-email.test' });
  const res = await updateMe(mia, { firstName: 'Mia', email: '' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.message, new RegExp(mia.username));
  assert.equal('email' in (await storedOf(mia)), false, 'the address is gone, not kept or stored as ""');
  assert.equal(res.body.data.email, undefined);

  const login = await h.inGym(gym, () => h.call(users.loginUser, { body: { email: mia.username, password: PASSWORD } }));
  assert.equal(login.statusCode, 200, JSON.stringify(login.body));
  assert.ok(login.body.token);
});

test('staff, anyone with two-factor on and a Google sign-in keep theirs, and are told why', async () => {
  const rae = await account({ firstName: 'Rae', lastName: 'Desk', email: 'rae@account-email.test', role: 'receptionist', employment: { isStaff: true } });
  const tess = await account({ firstName: 'Tess', lastName: 'Twofactor', email: 'tess@account-email.test', twoFactor: { enabled: true } });
  const gus = await h.inGym(gym, () => User.create({ firstName: 'Gus', lastName: 'Google', email: 'gus@account-email.test', provider: 'google', googleId: 'google-gus', password: null }));

  for (const [who, reason] of [[rae, /two-factor/i], [tess, /two-factor/i], [gus, /Google/]]) {
    const res = await updateMe(who, { email: '' });
    assert.equal(res.statusCode, 409, `${who.firstName}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.message, reason);
    assert.equal((await storedOf(who)).email, who.email, `${who.firstName} keeps the address`);
  }
});

test('a member who has no email can still save the rest of their profile', async () => {
  const nat = await account({ firstName: 'Nat', lastName: 'Noemail', phone: '0300 1110004' });
  // The profile form always sends the email box, empty or not.
  const res = await updateMe(nat, { firstName: 'Nat', lastName: 'Noemail', email: '', phone: '0300 1110005' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const stored = await storedOf(nat);
  assert.equal(stored.phone, '0300 1110005');
  assert.equal('email' in stored, false);
});
