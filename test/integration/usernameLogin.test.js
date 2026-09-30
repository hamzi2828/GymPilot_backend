// Signing in with a username on the website, against a real MongoDB: the one
// "Email or username" box finds the account either way, whatever the case,
// with the same answers, two-factor step and rules as before -- and staff can
// choose somebody's username, which moves their phone-app sign-in with it.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let gym;
let User;
let MemberDirectory;
let users;
let staff;
let admin;
let manager;
let member;
let phoneOnly;
let careful;

const PASSWORD = 'correct-horse-1';

const test = h.suite(async () => {
  User = h.src('models/user');
  MemberDirectory = h.src('platform/models/memberDirectoryModel');
  users = h.src('controller/userController');
  staff = h.src('controller/staffController');

  gym = await h.createGym('username-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User);
    await h.src('services/roleService').ensureDefaultRoles();
    const password = await bcrypt.hash(PASSWORD, 4);
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@username.test', role: 'admin', password, employment: { isStaff: true } });
    manager = await User.create({ firstName: 'Max', lastName: 'Manager', email: 'max@username.test', role: 'manager', password, employment: { isStaff: true } });
    member = await User.create({ firstName: 'Sara', lastName: 'Malik', email: 'sara@username.test', password });
    phoneOnly = await User.create({ firstName: 'Ali', lastName: 'Khan', phone: '0300 1234567', password });
    careful = await User.create({ firstName: 'Tess', lastName: 'Twofactor', email: 'tess@username.test', password, twoFactor: { enabled: true } });
  });
});

const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });
const login = (body) => h.inGym(gym, () => h.call(users.loginUser, { body }));

test('the sign-in box takes a username or an email, in any case', async () => {
  const byUsername = await login({ email: member.username.toUpperCase(), password: PASSWORD });
  assert.equal(byUsername.statusCode, 200, JSON.stringify(byUsername.body));
  assert.equal(byUsername.body.data.email, 'sara@username.test');

  assert.equal((await login({ email: '  SARA@Username.TEST ', password: PASSWORD })).statusCode, 200);
  assert.equal((await login({ username: member.username, password: PASSWORD })).statusCode, 200);
  assert.equal((await login({ login: member.username, password: PASSWORD })).statusCode, 200);
});

test('the desk app signs staff in by username too', async () => {
  const desktop = h.src('attendance/controller/desktopAppController');
  const DesktopToken = h.src('attendance/models/desktopTokenModel');
  const deskLogin = (body) => h.inGym(gym, () => h.call(desktop.login, { body }));
  await h.inGym(gym, async () => {
    await h.ensureIndexes(DesktopToken);
    await User.updateOne({ _id: manager._id }, { $set: { allowAttendanceApp: true } });
  });
  try {
    const byUsername = await deskLogin({ email: manager.username.toUpperCase(), password: PASSWORD });
    assert.equal(byUsername.statusCode, 200, JSON.stringify(byUsername.body));
    assert.ok(byUsername.body.token);
    assert.equal((await deskLogin({ email: 'max@username.test', password: PASSWORD })).statusCode, 200, 'email still works');
    assert.equal((await deskLogin({ email: manager.username, password: 'wrong-password-1' })).statusCode, 401);
  } finally {
    await h.inGym(gym, () => User.updateOne({ _id: manager._id }, { $set: { allowAttendanceApp: false } }));
  }
});

test('a member with no email signs in with their username', async () => {
  const res = await login({ email: phoneOnly.username, password: PASSWORD });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.token);
  assert.equal(res.body.data.email, undefined);
});

test('wrong details get the same answer whichever way they were typed', async () => {
  const wrongPassword = await login({ email: member.username, password: 'nope-nope-1' });
  const noSuchUser = await login({ email: 'nobodyhere123', password: PASSWORD });
  const noSuchEmail = await login({ email: 'nobody@username.test', password: PASSWORD });
  for (const res of [wrongPassword, noSuchUser, noSuchEmail]) {
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.message, 'Invalid credentials');
  }
  const empty = await login({ email: '', password: PASSWORD });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.body.message, /Email or username/);
});

test('a blank sign-in name is refused, never matched to the first account on file', async () => {
  // Spaces used to pass the "is anything there" check and become an empty
  // filter, and findOne({}) is the gym's first account -- its owner. Every
  // account here shares PASSWORD, so a match would sign straight in.
  for (const body of [{ email: '   ', password: PASSWORD }, { login: ' \t ', password: PASSWORD }, { username: ' ', password: PASSWORD }]) {
    const res = await login(body);
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.token, undefined);
  }
  const desktop = h.src('attendance/controller/desktopAppController');
  const desk = await h.inGym(gym, () => h.call(desktop.login, { body: { email: '   ', password: PASSWORD } }));
  assert.equal(desk.statusCode, 400, JSON.stringify(desk.body));
});

test('the desk counts failed sign-ins per account, however the name is typed', async () => {
  const desktop = h.src('attendance/controller/desktopAppController');
  const DesktopToken = h.src('attendance/models/desktopTokenModel');
  const deskLogin = (body) => h.inGym(gym, () => h.call(desktop.login, { body }));
  const dee = await h.inGym(gym, async () => {
    await h.ensureIndexes(DesktopToken);
    return User.create({ firstName: 'Dee', lastName: 'Desk', email: 'dee@username.test', role: 'receptionist', password: await bcrypt.hash(PASSWORD, 4), allowAttendanceApp: true, employment: { isStaff: true } });
  });

  // Eight wrong guesses, spread over every way of writing the account...
  const spellings = ['dee@username.test', ' DEE@username.test ', dee.username, ` ${dee.username.toUpperCase()}`];
  for (let i = 0; i < 8; i += 1) {
    const res = await deskLogin({ email: spellings[i % spellings.length], password: `wrong-guess-${i}` });
    assert.equal(res.statusCode, 401, JSON.stringify(res.body));
  }
  // ...and the account is throttled whichever spelling comes next.
  const next = await deskLogin({ email: dee.username, password: PASSWORD });
  assert.equal(next.statusCode, 429, JSON.stringify(next.body));

  // Somebody else at the same desk is not.
  await h.inGym(gym, () => User.updateOne({ _id: manager._id }, { $set: { allowAttendanceApp: true } }));
  try {
    assert.equal((await deskLogin({ email: 'max@username.test', password: PASSWORD })).statusCode, 200);
  } finally {
    await h.inGym(gym, () => User.updateOne({ _id: manager._id }, { $set: { allowAttendanceApp: false } }));
  }
});

test('two-factor still applies when signing in with a username', async () => {
  // The harness stands in for every notification export, the email
  // branding included; the code email needs the gym's name from it.
  const notify = h.src('services/gymNotifications');
  const stubbed = notify.brand;
  notify.brand = async () => ({ siteName: 'Username Gym' });
  try {
    const before = h.calls.emails.length;
    const res = await login({ email: careful.username, password: PASSWORD });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.requires2fa, true);
    assert.ok(res.body.challengeId);
    assert.equal(res.body.token, undefined, 'no token until the code comes back');
    assert.equal(h.calls.emails.length, before + 1);
    assert.equal(h.calls.emails[h.calls.emails.length - 1].to, 'tess@username.test');
  } finally {
    notify.brand = stubbed;
  }
});

test('staff choose a username: the new one signs in, the old one stops, the phone app follows', async () => {
  const old = member.username;
  const res = await h.inGym(gym, () => h.call(users.setUsername, { ...as(manager), params: { id: String(member._id) }, body: { username: 'SaraM' } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.username, 'saram');

  assert.equal((await login({ email: 'saram', password: PASSWORD })).statusCode, 200);
  assert.equal((await login({ email: old, password: PASSWORD })).statusCode, 401);

  const row = await MemberDirectory.lookup('saram');
  assert.equal(String(row.userId), String(member._id));
  assert.equal(await MemberDirectory.lookup(old), null);
});

test('a chosen username is letters and digits, unique, and an administrator\'s is an administrator\'s', async () => {
  const set = (actor, target, username) =>
    h.inGym(gym, () => h.call(users.setUsername, { ...as(actor), params: { id: String(target._id) }, body: { username } }));

  assert.equal((await set(admin, phoneOnly, 'ali khan')).statusCode, 400);
  assert.equal((await set(admin, phoneOnly, '12345')).statusCode, 400);
  const taken = await set(admin, phoneOnly, 'saram');
  assert.equal(taken.statusCode, 409);
  assert.match(taken.body.message, /already taken/);

  const toAdmin = await set(manager, admin, 'bossada');
  assert.equal(toAdmin.statusCode, 403);
  assert.equal((await set(admin, admin, 'bossada')).statusCode, 200);
});

test('the Staff screen lists usernames and sets them for staff only', async () => {
  const list = await h.inGym(gym, () => h.call(staff.list, { query: {} }));
  assert.equal(list.statusCode, 200);
  const max = list.body.staff.find((person) => person.id === String(manager._id));
  assert.equal(max.username, manager.username);

  const res = await h.inGym(gym, () => h.call(staff.setUsername, { ...as(admin), params: { id: String(manager._id) }, body: { username: 'maxdesk' } }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal((await login({ email: 'MaxDesk', password: PASSWORD })).statusCode, 200);

  const notStaff = await h.inGym(gym, () => h.call(staff.setUsername, { ...as(admin), params: { id: String(member._id) }, body: { username: 'whatever1' } }));
  assert.equal(notStaff.statusCode, 404);
});
