// "Is this address really theirs?", against a real MongoDB.
//
// A guest pays for a membership with nothing but an email address. Sign-up
// takes any address, and so does a member's own profile -- so until an
// address is shown to be its owner's (the emailed link, a Google sign-in, an
// emailed sign-in code or reset link, or staff vouching for it), it must
// claim none of what was bought under it: not at the door, not in the
// booking screen's membership, not in the data export. Everything under the
// account's own id is untouched throughout, and nobody is locked out.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let User;
let PackageOrder;
let Contact;
let users;
let security;
let people;
let verification;
let admin;

const PASSWORD = 'correct-horse-1';
const API = { protocol: 'https', host: 'api.gympilot.test' };

const test = h.suite(async () => {
  User = h.src('models/user');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Contact = h.src('models/contactModel');
  users = h.src('controller/userController');
  security = h.src('controller/securityController');
  people = h.src('attendance/services/peopleDirectory');
  verification = h.src('services/emailVerification');
  // The harness silences every export of gymNotifications, the brand lookup
  // the sign-in code email reads the gym's name from among them.
  h.src('services/gymNotifications').brand = async () => ({ siteName: 'Verify Gym' });

  gym = await h.createGym('verify-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User, PackageOrder);
    await h.src('services/roleService').ensureDefaultRoles();
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@verify.test', role: 'admin', password: await bcrypt.hash(PASSWORD, 4), employment: { isStaff: true } });
  });
});

async function settle(check, { tries = 60, every = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
  return false;
}

const inGym = (fn) => h.inGym(gym, fn);

/** h.call for the two handlers that answer a browser: a page, or a redirect. */
async function browse(handler, req = {}) {
  const res = h.fakeRes();
  res.type = () => res;
  res.redirect = (status, url) => {
    res.statusCode = status;
    res.redirectedTo = url;
    return res;
  };
  await handler({ query: {}, params: {}, body: {}, headers: {}, ...req }, res);
  return res;
}
const asJson = { is: (type) => (type === 'application/json' ? type : false) };
const bearer = (account) => `Bearer ${jwt.sign({ id: String(account._id), email: account.email, role: account.role || 'user' }, process.env.JWT_SECRET)}`;
// A request as the API sees it: the Host it was reached on is where the link points.
const request = (extra = {}) => ({ protocol: API.protocol, ...extra, headers: { host: API.host, ...(extra.headers || {}) } });
const as = (account, extra = {}) => request({ user: { id: String(account._id) }, ...extra, headers: { authorization: bearer(account), ...(extra.headers || {}) } });
const stored = (id) => h.rawDb(gym.database.name).collection('users').findOne({ _id: id });
const flagOf = async (id) => (await stored(id)).emailVerified;

let orderSeq = 0;
/** A paid membership a guest bought with nothing but `email`. */
function guestOrder(email) {
  const now = new Date();
  orderSeq += 1;
  return inGym(() =>
    PackageOrder.create({
      orderNumber: `VER-${orderSeq}`,
      userId: null,
      packageId: new h.state.mongoose.Types.ObjectId(),
      packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month' },
      customerInfo: { fullName: 'Gina Guest', email },
      payment: { method: 'stripe', amount: 40, currency: 'GBP', status: 'paid', paidAt: now },
      subscription: { startDate: now, endDate: new Date(now.getTime() + 30 * 86400000), isActive: true },
      status: 'active'
    })
  );
}

const signUp = (email, extra = {}) =>
  inGym(() => h.call(users.createUser, request({ body: { firstName: 'Sam', lastName: 'Signup', email, password: PASSWORD, ...extra } })));
const membershipOf = (id) => inGym(async () => people.membershipFor(await User.findById(id)));
const exportOf = async (account) => JSON.parse((await inGym(() => h.call(security.exportMyData, as(account)))).body);

/** The newest "confirm your email" message to `to`, and the token in its link. */
function confirmationTo(to) {
  const mail = [...h.calls.emails].reverse().find((m) => m.to === to && /Confirm your email/.test(m.subject));
  if (!mail) return null;
  const link = mail.html.match(/href="([^"]*\/user\/verify-email[^"]*)"/);
  const url = link ? new URL(link[1].replace(/&amp;/g, '&')) : null;
  return { mail, url, token: url && url.searchParams.get('token') };
}

test('registering a guest buyer\'s address claims nothing until its owner confirms it', async () => {
  const email = 'gina@verifygym.org';
  await guestOrder(email);
  await inGym(() => Contact.create({ fullName: 'Gina Guest', emailAddress: email, subject: 'Question', message: 'Do you have parking?' }));

  // Somebody who is not Gina signs up with her address.
  const res = await signUp(email);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const id = res.body.data._id;
  assert.equal(res.body.data.emailVerified, false);
  assert.equal(await flagOf(id), false);
  for (const key of ['emailVerifyTokenHash', 'emailVerifyExpiresAt', 'password']) {
    assert.equal(key in res.body.data, false, `${key} is not in the answer`);
  }

  // They sign in as before: nothing waits on the confirmation.
  const login = await inGym(() => h.call(users.loginUser, { body: { email, password: PASSWORD } }));
  assert.equal(login.statusCode, 200, JSON.stringify(login.body));
  assert.equal(login.body.data.emailVerified, false);

  // ...but Gina's membership is not theirs: not at the door, not in a
  // download of "their" data.
  assert.equal((await membershipOf(id)).status, 'none');
  const account = await inGym(() => User.findById(id));
  const before = await exportOf(account);
  assert.equal(before.memberships.length, 0);
  assert.equal(before.enquiries.length, 0);
  assert.match(before.note, /not confirmed yet/);
  // The office's list answers as the desk does, even from a projection
  // that never asked for the flag.
  const lean = await inGym(() => User.findById(id).select('firstName lastName email').lean());
  assert.equal('emailVerified' in lean, false);
  assert.equal((await inGym(() => people.membershipsFor([lean]))).get(String(id)).status, 'none');
  assert.equal((await inGym(() => people.membershipFor(lean))).status, 'none');

  // The link went to the address itself, and points at this API for this gym.
  assert.ok(await settle(() => !!confirmationTo(email)), 'a confirmation email was sent');
  const { mail, url, token } = confirmationTo(email);
  assert.equal(url.origin, `${API.protocol}://${API.host}`);
  assert.equal(url.pathname, '/user/verify-email');
  assert.equal(url.searchParams.get('tenant'), gym.slug);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.match(mail.html, /ignore this email/);
  // Only the hash is kept.
  const row = await stored(account._id);
  assert.equal(row.emailVerifyTokenHash.length, 64);
  assert.notEqual(row.emailVerifyTokenHash, token);
  assert.ok(row.emailVerifyExpiresAt > new Date());

  // Opening the link changes nothing -- a mail scanner opens every link.
  const page = await inGym(() => browse(security.verifyEmailPage, { query: { token } }));
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<form method="post" action="\/user\/verify-email\?tenant=verify-gym"/);
  assert.ok(page.body.includes(email));
  assert.equal(await flagOf(account._id), false);
  assert.equal((await membershipOf(id)).status, 'none');

  // Pressing its button does, and sends the person to the gym's sign-in page.
  const done = await inGym(() => browse(security.verifyEmail, { body: { token } }));
  assert.equal(done.statusCode, 303, JSON.stringify(done.body));
  assert.equal(done.redirectedTo, 'http://verify-gym.test/authentication?emailVerified=1');
  const after = await stored(account._id);
  assert.equal(after.emailVerified, true);
  assert.equal(after.emailVerifyTokenHash, null);

  // Now the address is theirs, and so is what was bought under it.
  assert.equal((await membershipOf(id)).status, 'active');
  const full = await exportOf(account);
  assert.equal(full.memberships.length, 1);
  assert.equal(full.enquiries.length, 1);
  assert.doesNotMatch(full.note, /not confirmed/);

  // Single use.
  const again = await inGym(() => browse(security.verifyEmail, { body: { token }, ...asJson }));
  assert.equal(again.statusCode, 400);
  assert.equal(again.body.code, 'VERIFY_LINK_INVALID');
  assert.equal((await inGym(() => browse(security.verifyEmailPage, { query: { token } }))).statusCode, 400);
  assert.equal((await inGym(() => browse(security.verifyEmail, { body: { token } }))).statusCode, 400);
});

test('what is filed under the account itself never waits on the confirmation', async () => {
  const res = await signUp('owen@verify.test');
  const id = res.body.data._id;
  const now = new Date();
  await inGym(() =>
    PackageOrder.create({
      orderNumber: 'VER-OWN',
      userId: id,
      packageId: new h.state.mongoose.Types.ObjectId(),
      packageDetails: { name: 'Monthly', price: '40', currency: 'GBP', period: 'month' },
      customerInfo: { fullName: 'Sam Signup', email: 'owen@verify.test' },
      payment: { method: 'cash', amount: 40, currency: 'GBP', status: 'paid', paidAt: now },
      subscription: { startDate: now, endDate: new Date(now.getTime() + 30 * 86400000), isActive: true },
      status: 'active'
    })
  );
  assert.equal(await flagOf((await inGym(() => User.findById(id)))._id), false);
  assert.equal((await membershipOf(id)).status, 'active');
  assert.equal((await exportOf(await inGym(() => User.findById(id)))).memberships.length, 1);
});

test('accounts from before the flag, and accounts staff made, count as confirmed', async () => {
  await guestOrder('olive@verify.test');
  await guestOrder('desk@verify.test');

  // As every account was stored before the field existed: no value at all.
  const legacyId = new h.state.mongoose.Types.ObjectId();
  await h.rawDb(gym.database.name).collection('users').insertOne({
    _id: legacyId, firstName: 'Olive', lastName: 'Old', email: 'olive@verify.test', username: 'oliveold901', role: 'user', isActive: true, password: await bcrypt.hash(PASSWORD, 4)
  });
  assert.equal('emailVerified' in (await stored(legacyId)), false);
  assert.equal((await membershipOf(legacyId)).status, 'active');
  const lean = await inGym(() => User.findById(legacyId).select('email').lean());
  assert.equal((await inGym(() => people.membershipsFor([lean]))).get(String(legacyId)).status, 'active');
  assert.equal((await exportOf({ _id: legacyId, email: 'olive@verify.test' })).memberships.length, 1);

  // The desk typed this address in for the member standing in front of it.
  const made = await inGym(() =>
    h.call(users.adminCreateUser, { user: { id: String(admin._id), role: 'admin' }, roleSlug: 'admin', body: { firstName: 'Dee', lastName: 'Desk', email: 'desk@verify.test', credentials: 'show' } })
  );
  assert.equal(made.statusCode, 201, JSON.stringify(made.body));
  assert.equal(await flagOf((await inGym(() => User.findOne({ email: 'desk@verify.test' })))._id), true);
  assert.equal((await membershipOf(made.body.data._id)).status, 'active');
});

test('a member who changes their own address has to confirm the new one', async () => {
  await guestOrder('victim@verify.test');
  const mia = await inGym(async () => User.create({ firstName: 'Mia', lastName: 'Mover', email: 'mia@verify.test', password: await bcrypt.hash(PASSWORD, 4) }));
  assert.equal(await flagOf(mia._id), true, 'made by the gym: confirmed');

  // A reset link is out, to the old address.
  await inGym(() => h.call(users.forgotPassword, { body: { email: 'mia@verify.test' } }));
  assert.ok(await settle(async () => !!(await stored(mia._id)).passwordResetTokenHash));

  const res = await inGym(() => h.call(users.updateUser, as(mia, { body: { firstName: 'Mia', email: 'Victim@Verify.test ', currentPassword: PASSWORD } })));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.email, 'victim@verify.test');
  assert.equal(res.body.data.emailVerified, false);
  assert.match(res.body.message, /confirm the address is yours/);
  const row = await stored(mia._id);
  assert.equal(row.emailVerified, false);
  assert.equal(row.passwordResetTokenHash, null, 'the link sent to the old address is dead');
  assert.equal((await membershipOf(mia._id)).status, 'none');

  assert.ok(await settle(() => !!confirmationTo('victim@verify.test')), 'the new address is sent the link');
  // Saving the profile again with the same address is not a change.
  const sentBefore = h.calls.emails.length;
  const same = await inGym(() => h.call(users.updateUser, as(mia, { body: { lastName: 'Moved', email: 'victim@verify.test' } })));
  assert.equal(same.statusCode, 200, JSON.stringify(same.body));
  assert.equal(same.body.message, 'User updated successfully');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.calls.emails.length, sentBefore);

  // Somebody else's address is refused as the sign-up form refuses it.
  const taken = await inGym(() => h.call(users.updateUser, as(mia, { body: { email: 'ada@verify.test', currentPassword: PASSWORD } })));
  assert.equal(taken.statusCode, 409, JSON.stringify(taken.body));
  assert.equal(taken.body.message, 'Email already in use');
  const junk = await inGym(() => h.call(users.updateUser, as(mia, { body: { email: 'a@b.test, c@d.test', currentPassword: PASSWORD } })));
  assert.equal(junk.statusCode, 400);
});

test('a fresh link can be asked for, and a link that cannot be sent leaves nothing behind', async () => {
  const res = await signUp('fay@verify.test');
  const fay = await inGym(() => User.findById(res.body.data._id));
  assert.ok(await settle(() => !!confirmationTo('fay@verify.test')));
  const first = confirmationTo('fay@verify.test').token;

  const sent = await inGym(() => h.call(security.sendVerifyEmail, as(fay)));
  assert.equal(sent.statusCode, 200, JSON.stringify(sent.body));
  const second = confirmationTo('fay@verify.test').token;
  assert.notEqual(second, first);
  // Only the newest link works.
  assert.equal(await inGym(() => verification.pending(first)), null);
  assert.ok(await inGym(() => verification.pending(second)));

  // The gym's email is down: said so, and no token is left valid.
  h.setEmailFailure('SMTP is down');
  try {
    const failed = await inGym(() => h.call(security.sendVerifyEmail, as(fay)));
    assert.equal(failed.statusCode, 503, JSON.stringify(failed.body));
    assert.equal((await stored(fay._id)).emailVerifyTokenHash, null);
    assert.equal(await flagOf(fay._id), false);
  } finally {
    h.setEmailFailure(null);
  }
  // Still an account that signs in.
  assert.equal((await inGym(() => h.call(users.loginUser, { body: { email: 'fay@verify.test', password: PASSWORD } }))).statusCode, 200);

  // A JSON caller is answered in JSON.
  await inGym(() => h.call(security.sendVerifyEmail, as(fay)));
  const json = await inGym(() => browse(security.verifyEmail, { body: { token: confirmationTo('fay@verify.test').token }, ...asJson }));
  assert.equal(json.statusCode, 200, JSON.stringify(json.body));
  assert.deepEqual(json.body.data, { email: 'fay@verify.test', emailVerified: true });
  const already = await inGym(() => h.call(security.sendVerifyEmail, as(fay)));
  assert.equal(already.body.alreadyVerified, true);

  // An account with no address has nothing to confirm, and is not broken by asking.
  const pat = await inGym(async () => User.create({ firstName: 'Pat', lastName: 'Phone', phone: '0300 5550001', password: await bcrypt.hash(PASSWORD, 4) }));
  assert.equal((await inGym(() => h.call(security.sendVerifyEmail, as(pat)))).statusCode, 409);
  assert.equal((await membershipOf(pat._id)).status, 'none');
});

test('a password reset through the emailed link confirms the address it was sent to', async () => {
  await guestOrder('rex@verify.test');
  const res = await signUp('rex@verify.test');
  const id = res.body.data._id;
  assert.equal((await membershipOf(id)).status, 'none');

  const before = h.calls.emails.length;
  await inGym(() => h.call(users.forgotPassword, { body: { email: 'rex@verify.test' } }));
  assert.ok(await settle(() => h.calls.emails.slice(before).some((m) => /Reset your/.test(m.subject))));
  const mail = h.calls.emails.slice(before).find((m) => /Reset your/.test(m.subject));
  const token = new URL(mail.html.match(/href="([^"]*mode=reset[^"]*)"/)[1].replace(/&amp;/g, '&')).searchParams.get('token');

  const reset = await inGym(() => h.call(users.resetPassword, { body: { token, password: 'a-new-password-1' } }));
  assert.equal(reset.statusCode, 200, JSON.stringify(reset.body));
  assert.equal(await flagOf((await inGym(() => User.findById(id)))._id), true);
  assert.equal((await membershipOf(id)).status, 'active');
});

test('a right sign-in code confirms the address it was emailed to, and no other', async () => {
  const one = await signUp('tia@verify.test');
  const tia = await inGym(() => User.findById(one.body.data._id));
  await inGym(() => User.updateOne({ _id: tia._id }, { $set: { 'twoFactor.enabled': true } }));

  const codeFrom = (to, since) => {
    const mail = h.calls.emails.slice(since).find((m) => m.to === to && /sign-in code/.test(m.subject + m.html));
    return mail && mail.html.match(/>(\d{6})</)[1];
  };

  let since = h.calls.emails.length;
  let login = await inGym(() => h.call(users.loginUser, { body: { email: 'tia@verify.test', password: PASSWORD } }));
  assert.equal(login.body.requires2fa, true, JSON.stringify(login.body));
  let done = await inGym(() => h.call(security.verifyTwoFactor, { body: { challengeId: login.body.challengeId, code: codeFrom('tia@verify.test', since) } }));
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  assert.equal(await flagOf(tia._id), true);
  assert.equal(done.body.data.emailVerified, true);
  assert.equal('sentTo' in done.body.data.twoFactor, false);

  // The code goes to one address; the account's is changed before it is typed.
  await guestOrder('target@verify.test');
  since = h.calls.emails.length;
  login = await inGym(() => h.call(users.loginUser, { body: { email: 'tia@verify.test', password: PASSWORD } }));
  const code = codeFrom('tia@verify.test', since);
  const moved = await inGym(() => h.call(users.updateUser, as(tia, { body: { email: 'target@verify.test', currentPassword: PASSWORD } })));
  assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));
  done = await inGym(() => h.call(security.verifyTwoFactor, { body: { challengeId: login.body.challengeId, code } }));
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  assert.equal(await flagOf(tia._id), false, 'a code read from the old mailbox says nothing about the new address');
  assert.equal((await membershipOf(tia._id)).status, 'none');
});

test('the desk can vouch for a member\'s address, but not for its own or an administrator\'s', async () => {
  await guestOrder('walk@verify.test');
  const res = await signUp('walk@verify.test');
  const id = res.body.data._id;
  assert.equal((await membershipOf(id)).status, 'none');

  const desk = await inGym(async () =>
    User.create({ firstName: 'Rae', lastName: 'Desk', email: 'rae@verify.test', role: 'receptionist', employment: { isStaff: true }, password: await bcrypt.hash(PASSWORD, 4) })
  );
  const by = (actor, target) =>
    inGym(() => h.call(security.vouchEmail, { user: { id: String(actor._id), role: actor.role }, roleSlug: actor.role, params: { id: String(target) } }));

  const vouched = await by(desk, id);
  assert.equal(vouched.statusCode, 200, JSON.stringify(vouched.body));
  assert.match(vouched.body.message, /Sam Signup's email address is marked as confirmed/);
  assert.equal(await flagOf((await inGym(() => User.findById(id)))._id), true);
  assert.equal((await membershipOf(id)).status, 'active');

  // Not an address the desk typed for itself, and not an administrator's.
  await inGym(() => User.updateOne({ _id: desk._id }, { $set: { emailVerified: false } }));
  const own = await by(desk, desk._id);
  assert.equal(own.statusCode, 403, JSON.stringify(own.body));
  assert.equal(await flagOf(desk._id), false);
  await inGym(() => User.updateOne({ _id: admin._id }, { $set: { emailVerified: false } }));
  const above = await by(desk, admin._id);
  assert.equal(above.statusCode, 403, JSON.stringify(above.body));
  assert.match(above.body.message, /Only an administrator/);
  assert.equal(await flagOf(admin._id), false);
  assert.equal((await by(admin, desk._id)).statusCode, 200);
  await inGym(() => User.updateOne({ _id: admin._id }, { $set: { emailVerified: true } }));
});
