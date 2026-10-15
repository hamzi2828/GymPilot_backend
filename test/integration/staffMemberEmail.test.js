// Staff adding, changing and removing a member's email address from the
// member's profile (PUT /admin/users/:id/profile), against a real MongoDB.
// It used to be ignored while the answer still said "Profile saved.": now it
// is saved -- lowercased and trimmed, checked, one account per address -- or
// refused with the reason, and nothing else in the request is saved either.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let gym;
let User;
let profiles;
let admin;
let phoneOnly;
let withEmail;
let googleMember;

const test = h.suite(async () => {
  User = h.src('models/user');
  profiles = h.src('controller/memberProfileController');

  gym = await h.createGym('staff-email-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User);
    await h.src('services/roleService').ensureDefaultRoles();
    const password = await bcrypt.hash('member-pass-1', 4);
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@staffemail.test', role: 'admin', password, employment: { isStaff: true } });
    phoneOnly = await User.create({ firstName: 'Pervez', lastName: 'Phone', phone: '0301-1112223', role: 'user', password, memberCode: 'GP-0101' });
    withEmail = await User.create({ firstName: 'Erum', lastName: 'Email', email: 'erum@staffemail.test', role: 'user', password, memberCode: 'GP-0102', passwordResetTokenHash: 'old-reset' });
    googleMember = await User.create({ firstName: 'Gul', lastName: 'Google', email: 'gul@staffemail.test', role: 'user', provider: 'google', googleId: 'g-1', password: null });
  });
});

const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });
const save = (target, body, actor = admin) => h.inGym(gym, () => h.call(profiles.updateProfile, { ...as(actor), params: { id: String(target._id) }, body }));
const reload = (target) => h.inGym(gym, () => User.findById(target._id).select('+passwordResetTokenHash').lean());
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('staff give a phone-only member an email address, kept lowercase and trimmed', async () => {
  const res = await save(phoneOnly, { email: '  Pervez.Phone@Example.COM ', firstName: 'Pervez' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.message, 'Profile saved. Their email address is now pervez.phone@example.com.');
  assert.equal(res.body.data.email, 'pervez.phone@example.com');
  const after = await reload(phoneOnly);
  assert.equal(after.email, 'pervez.phone@example.com');
  assert.notEqual(after.emailVerified, false, 'typed by staff: vouched for, as a desk-made account is');

  const shown = await h.inGym(gym, () => h.call(profiles.profile, { params: { id: String(phoneOnly._id) } }));
  assert.equal(shown.body.data.email, 'pervez.phone@example.com');
});

test('changing an address tells the old one and ends the reset link sent to it', async () => {
  const before = h.calls.emails.length;
  const res = await save(withEmail, { email: 'erum.new@staffemail.test' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  await settle();
  const after = await reload(withEmail);
  assert.equal(after.email, 'erum.new@staffemail.test');
  assert.equal(after.passwordResetTokenHash, null);
  const sent = h.calls.emails.slice(before);
  assert.ok(sent.some((mail) => mail.to === 'erum@staffemail.test' && /changed/.test(mail.subject)), JSON.stringify(sent.map((m) => [m.to, m.subject])));
});

test('a bad or taken address is refused with the reason, and nothing in the request is saved', async () => {
  const bad = await save(phoneOnly, { email: 'not-an-email', phone: '0300 0000000' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.message, /not a valid email address/);

  const taken = await save(phoneOnly, { email: 'ERUM.NEW@staffemail.test', phone: '0300 0000000' });
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.body.message, 'erum.new@staffemail.test is already used by Erum Email (GP-0102). Each account needs its own email address.');

  const after = await reload(phoneOnly);
  assert.equal(after.email, 'pervez.phone@example.com');
  assert.equal(after.phone, '0301-1112223', 'the phone in the refused request was not saved either');

  // The same address it already has is no change at all.
  const same = await save(phoneOnly, { email: 'Pervez.Phone@example.com' });
  assert.equal(same.statusCode, 200);
  assert.equal(same.body.message, 'Profile saved.');
});

test('removing the address: allowed for a member with a phone, refused when it is the last way to reach them', async () => {
  const lonely = await h.inGym(gym, async () => User.create({ firstName: 'Lone', lastName: 'Email', email: 'lone@staffemail.test', role: 'user', password: 'x' }));
  const refused = await save(lonely, { email: '' });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.body.message, /Add a phone number before removing the email address/);
  assert.equal((await reload(lonely)).email, 'lone@staffemail.test');

  const removed = await save(lonely, { email: '', phone: '0333 4445556' });
  assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));
  assert.match(removed.body.message, /email address was removed/);
  const after = await reload(lonely);
  assert.equal('email' in after, false, 'unset, never stored as ""');
  assert.equal(after.phone, '0333 4445556');

  // Two members without an email side by side are fine.
  const other = await save(withEmail, { email: null, phone: '0333 4445557' });
  assert.equal(other.statusCode, 200, JSON.stringify(other.body));
});

test('a Google sign-in, a staff account and your own address are not changed from here', async () => {
  const google = await save(googleMember, { email: '' });
  assert.equal(google.statusCode, 409);
  assert.match(google.body.message, /Google/);

  const colleague = await h.inGym(gym, async () => User.create({ firstName: 'Sam', lastName: 'Staff', email: 'sam@staffemail.test', role: 'receptionist', password: 'x', employment: { isStaff: true } }));
  const staff = await save(colleague, { email: '' });
  assert.equal(staff.statusCode, 409);
  assert.match(staff.body.message, /Staff accounts keep an email address/);

  const own = await save(admin, { email: 'ada.new@staffemail.test' });
  assert.equal(own.statusCode, 403);
  assert.equal((await reload(admin)).email, 'ada@staffemail.test');
});

test('an empty name is refused instead of being quietly skipped', async () => {
  const res = await save(phoneOnly, { firstName: '  ' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'First name cannot be left empty.');
});
