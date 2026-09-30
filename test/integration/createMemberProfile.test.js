// Creating a member with the details the desk takes down at the counter,
// against a real MongoDB: gender, date of birth, a one-line address, phone
// and the staff's note are stored where the rest of the account keeps them,
// the note never comes back in the member-facing view, the admin profile
// shows and edits the address, and the create step can be called as part of
// something larger (createMemberAccount) as well as from its route.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let gym;
let User;
let users;
let profiles;
let admin;

const test = h.suite(async () => {
  User = h.src('models/user');
  users = h.src('controller/userController');
  profiles = h.src('controller/memberProfileController');

  gym = await h.createGym('profile-create-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User);
    await h.src('services/roleService').ensureDefaultRoles();
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@profile.test', role: 'admin', password: await bcrypt.hash('admin-pass-1', 4), employment: { isStaff: true } });
  });
});

const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });
const create = (body) => h.inGym(gym, () => h.call(users.adminCreateUser, { ...as(admin), body }));

test('the desk creates a member with gender, date of birth, address, phone and a staff note', async () => {
  const res = await create({
    firstName: 'Hina',
    lastName: 'Profile',
    phone: '0300 5555555',
    gender: 'female',
    dateOfBirth: '1994-02-20',
    address: '7 Canal View, Lahore',
    staffNotes: 'Prefers the women-only hour'
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));

  const view = res.body.data;
  assert.equal(view.gender, 'female');
  assert.equal(new Date(view.dateOfBirth).toISOString().slice(0, 10), '1994-02-20');
  assert.equal(view.addresses[0].address, '7 Canal View, Lahore');
  assert.equal(view.staffNotes, undefined, 'the staff note stays out of the account view');
  assert.match(view.memberCode, /^GP-\d{4}$/);

  const stored = await h.inGym(gym, () => User.findById(view._id).select('+staffNotes').lean());
  assert.equal(stored.staffNotes, 'Prefers the women-only hour');
  assert.equal(stored.phone, '0300 5555555');
  assert.deepEqual([stored.addresses.length, stored.addresses[0].label, stored.addresses[0].isDefault], [1, 'primary', true]);
});

test('a bad detail refuses the whole create, and nothing is made', async () => {
  for (const [body, message] of [
    [{ dateOfBirth: '2999-01-01' }, /future/],
    [{ dateOfBirth: 'soon' }, /not a date/],
    [{ address: { line1: 'x' } }, /one line/]
  ]) {
    const res = await create({ firstName: 'Bad', lastName: 'Detail', phone: '0300 0000000', ...body });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, message);
  }
  assert.equal(await h.inGym(gym, () => User.exists({ firstName: 'Bad' })), null);
});

test('the admin profile shows the address and edits it in place', async () => {
  const hina = await h.inGym(gym, () => User.findOne({ firstName: 'Hina' }).lean());
  const shown = await h.inGym(gym, () => h.call(profiles.profile, { params: { id: String(hina._id) } }));
  assert.equal(shown.statusCode, 200);
  assert.equal(shown.body.data.address, '7 Canal View, Lahore');

  const saved = await h.inGym(gym, () => h.call(profiles.updateProfile, { params: { id: String(hina._id) }, body: { address: '9 Mall Road, Lahore' } }));
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  const after = await h.inGym(gym, () => User.findById(hina._id).lean());
  assert.equal(after.addresses.length, 1, 'the same entry, not a second one');
  assert.equal(after.addresses[0].address, '9 Mall Road, Lahore');
});

test('another screen can create the account as one step and carry on with it', async () => {
  const result = await h.inGym(gym, () =>
    users.createMemberAccount(as(admin), { firstName: 'Omar', lastName: 'Onescreen', phone: '0300 7777777', gender: 'male' })
  );
  assert.equal(result.status, 201);
  assert.ok(result.user && result.user._id, 'the account itself, to sell a package to next');
  assert.equal(result.noStore, true, 'no email: the password is in the answer, which must not be cached');
  assert.equal(typeof result.body.password, 'string');
  assert.equal(result.user.gender, 'male');

  const refused = await h.inGym(gym, () => users.createMemberAccount(as(admin), { firstName: 'No', lastName: 'Contact' }));
  assert.equal(refused.status, 400);
  assert.equal(refused.user, undefined);
});
