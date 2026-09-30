// The desk's one-screen "Add member" (POST /api/admin/members/register),
// against a real MongoDB: the account, the membership and the money taken in
// one request -- a partial payment and a trainer included -- and all or
// nothing: a sale that fails takes the new account back out, and what can be
// refused before the account exists is refused before it is made.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let gym;
let User;
let PackageOrder;
let Package;
let Trainer;
let Role;
let MemberDirectory;
let membership;
let register;
let requirePermission;
let monthly;
let coach;
let retired;
let admin;
let receptionist;
let clerk;
let trainerStaff;

const test = h.suite(async () => {
  User = h.src('models/user');
  PackageOrder = h.src('gymfolio/models/packageOrderModel');
  Package = h.src('gymfolio/models/packageModel');
  Trainer = h.src('gymfolio/models/trainerModel');
  Role = h.src('models/roleModel');
  MemberDirectory = h.src('platform/models/memberDirectoryModel');
  membership = h.src('gymfolio/services/membershipService');
  register = h.src('controller/memberRegistrationController').register;
  requirePermission = h.src('middleware/requirePermission');
  const { fullPermissionMap } = h.src('config/permissions');
  const roles = h.src('services/roleService');

  gym = await h.createGym('register-gym', { timezone: 'Asia/Karachi', currency: 'PKR' });
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User, PackageOrder);
    await roles.ensureDefaultRoles();
    // May add members but only look at memberships.
    await Role.create({
      name: 'Membership clerk',
      slug: 'membership-clerk',
      isStaff: true,
      permissions: fullPermissionMap({ users: 'manage', 'package-orders': 'view' })
    });
    roles.invalidate();

    const hashed = await bcrypt.hash('staff-password-1', 4);
    const staff = (first, role) =>
      User.create({ firstName: first, lastName: 'Staff', email: `${first.toLowerCase()}@register.test`, role, password: hashed, employment: { isStaff: true } });
    admin = await staff('Ada', 'admin');
    receptionist = await staff('Rae', 'receptionist');
    clerk = await staff('Cal', 'membership-clerk');
    trainerStaff = await staff('Tom', 'trainer');

    monthly = await Package.create({ name: 'Monthly', price: '5000', currency: 'PKR', period: 'month', features: ['Gym floor'], joiningFee: 2000 });
    coach = await Trainer.create({ name: 'Coach Kamran', role: 'Head coach', isActive: true, commissionType: 'percent', commissionValue: 20 });
    retired = await Trainer.create({ name: 'Old Coach', role: 'Coach', isActive: false });
  });
});

// What auth + requirePermission leave on the request.
const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });

const post = (actor, body) => h.inGym(gym, () => h.call(register, { ...as(actor), method: 'POST', body }));

const inGym = (fn) => h.inGym(gym, fn);

test('a member registered with a package, a trainer and part of the money: one request, everything recorded', async () => {
  const notesBefore = h.calls.notifications.length;
  const res = await post(receptionist, {
    firstName: 'Sana',
    lastName: 'Khan',
    phone: '0300 1234567',
    gender: 'female',
    address: 'House 4, Street 9, Lahore',
    credentials: 'show',
    membership: {
      packageId: String(monthly._id),
      paymentMethod: 'jazzcash',
      startAfterDays: 2,
      discountAmount: 500,
      discountNote: 'Student',
      trainerId: String(coach._id),
      trainerFee: 3000,
      trainerCommissionType: 'percent',
      trainerCommissionValue: 20,
      amountPaid: 4000
    }
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const { member, order } = res.body;

  // The account, as POST /admin/users makes it: a member ID, a username, the
  // password shown once and never cached.
  assert.match(member.memberCode, /^GP-\d{4}$/);
  assert.ok(member.username);
  assert.equal(member.role, 'user');
  assert.equal(res.body.credentials, 'show');
  assert.equal(typeof res.body.password, 'string');
  assert.equal(res.headers['cache-control'], 'no-store');

  // The membership: 5000 - 500 discount + 2000 admission + 3000 trainer,
  // 4000 taken now by JazzCash and the rest owed.
  assert.equal(String(order.userId), String(member._id));
  assert.equal(order.status, 'active');
  assert.equal(order.payment.method, 'jazzcash');
  assert.equal(order.payment.amount, 9500);
  assert.equal(order.payment.discountAmount, 500);
  assert.equal(order.payment.discountNote, 'Student');
  assert.equal(order.payment.joiningFee, 2000);
  assert.equal(order.payment.trainerFee, 3000);
  assert.equal(order.payment.amountPaid, 4000);
  assert.equal(order.payment.balanceDue, 5500);
  assert.equal(order.trainerAssignment.trainerName, 'Coach Kamran');
  assert.equal(order.trainerAssignment.commissionAmount, 600);

  await inGym(async () => {
    const saved = await User.findById(member._id).lean();
    assert.equal(String(saved.assignedTrainerId), String(coach._id));
    // Registered today, whatever the membership's start.
    assert.ok(Date.now() - new Date(saved.createdAt).getTime() < 60000);
    const T = h.src('attendance/services/timeUtils');
    assert.equal(T.dateKey(new Date(order.subscription.startDate)), T.shiftDateKey(T.dateKey(new Date()), 2));
    assert.equal(await PackageOrder.countDocuments({ userId: member._id }), 1);
  });
  const confirmed = h.calls.notifications.slice(notesBefore).filter((call) => call.name === 'membershipConfirmed');
  assert.equal(confirmed.length, 1, 'the member is sent the membership confirmation');
});

test('a different admission fee is charged as the admission fee, not taken off the total', async () => {
  const res = await post(admin, {
    firstName: 'Fam',
    lastName: 'Rate',
    phone: '0355 1212121',
    credentials: 'show',
    membership: { packageId: String(monthly._id), joiningFeeOverride: 1000, paymentMethod: 'easypaisa' }
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const { payment, packageDetails } = res.body.order;
  assert.equal(payment.amount, 6000);
  assert.equal(payment.joiningFee, 1000, 'the accounts count it as admission');
  assert.equal(payment.method, 'easypaisa');
  assert.equal(packageDetails.joiningFee, 1000);
  // The package itself is unchanged.
  assert.equal((await inGym(() => Package.findById(monthly._id).lean())).joiningFee, 2000);

  const both = await post(admin, {
    firstName: 'Fam',
    lastName: 'Both',
    phone: '0355 1212122',
    membership: { packageId: String(monthly._id), joiningFeeOverride: 1000, waiveJoiningFee: true }
  });
  assert.equal(both.statusCode, 400);
  assert.match(both.body.message, /not both/);
  const negative = await post(admin, { firstName: 'Fam', lastName: 'Neg', phone: '0355 1212123', membership: { packageId: String(monthly._id), joiningFeeOverride: -5 } });
  assert.equal(negative.statusCode, 400);
  assert.equal(await inGym(() => User.countDocuments({ phone: { $in: ['0355 1212122', '0355 1212123'] } })), 0);
});

test('without a membership it registers the member alone', async () => {
  const res = await post(receptionist, { firstName: 'Omar', lastName: 'Solo', email: 'omar@register.test' });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.order, null);
  assert.equal(res.body.credentials, 'email');
  assert.equal(res.body.emailed, true);
  assert.match(res.body.member.memberCode, /^GP-\d{4}$/);
});

test('a sale that fails takes the new account back out, with its directory row and any order it saved', async () => {
  const original = membership.createManualOrder;
  let made = null;
  let publishedWhileMade = null;
  // A sale that gets as far as saving its order, then fails.
  membership.createManualOrder = async (input) => {
    made = input.user._id;
    publishedWhileMade = await MemberDirectory.findOne({ userId: made }).lean();
    await PackageOrder.create({
      orderNumber: `TEST-${Date.now()}`,
      userId: input.user._id,
      packageId: input.pkg._id,
      packageDetails: membership.packageSnapshot(input.pkg),
      customerInfo: { fullName: 'Rolled Back', email: '', phone: '' },
      payment: { method: 'cash', amount: 5000, currency: 'pkr', status: 'pending' },
      status: 'pending'
    });
    throw new membership.MembershipError('The till could not record the sale', 409, 'TEST_SALE_FAILED');
  };
  let res;
  try {
    res = await post(admin, {
      firstName: 'Rolled',
      lastName: 'Back',
      phone: '0311 7654321',
      credentials: 'show',
      membership: { packageId: String(monthly._id) }
    });
  } finally {
    membership.createManualOrder = original;
  }

  // The order's own refusal, and no password for an account that is gone.
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'TEST_SALE_FAILED');
  assert.equal(res.body.message, 'The till could not record the sale');
  assert.equal(res.body.password, undefined);

  await inGym(async () => {
    assert.equal(await User.countDocuments({ phone: '0311 7654321' }), 0, 'the account is deleted');
    assert.equal(await PackageOrder.countDocuments({ 'customerInfo.fullName': 'Rolled Back' }), 0, 'the order it saved is deleted');
  });
  // Saving the account published its username for the phone app; it is
  // withdrawn again, so the name can be issued to somebody else.
  assert.ok(publishedWhileMade, 'the account was in the directory while it existed');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await MemberDirectory.findOne({ userId: made }).lean(), null, 'no directory row outlives its account');
});

test('an unexpected failure part-way is rolled back too, and answered as a failure', async () => {
  const original = membership.createManualOrder;
  membership.createManualOrder = async () => {
    throw new Error('connection reset');
  };
  let res;
  try {
    res = await post(admin, { firstName: 'Una', lastName: 'Lucky', phone: '0322 1112223', membership: { packageId: String(monthly._id) } });
  } finally {
    membership.createManualOrder = original;
  }
  assert.equal(res.statusCode, 500);
  assert.match(res.body.message, /connection reset/);
  assert.equal(await inGym(() => User.countDocuments({ phone: '0322 1112223' })), 0);
});

test('what can be refused before the account exists never creates or emails one', async () => {
  const emailsBefore = h.calls.emails.length;
  const cases = [
    [{ trainerId: String(retired._id), trainerFee: 1000 }, 409, 'TRAINER_INACTIVE'],
    [{ trainerId: '64b000000000000000000000', trainerFee: 1000 }, 404, 'TRAINER_NOT_FOUND'],
    [{ startAfterDays: 400 }, 400, 'INVALID_TERMS'],
    // 5000 + 2000 admission is the most this sale can take.
    [{ amountPaid: 7001 }, 400, 'INVALID_TERMS'],
    [{ paymentMethod: 'stripe' }, 422, 'PAYMENT_METHOD_INVALID'],
    [{ packageId: '64b000000000000000000000' }, 404, 'PACKAGE_NOT_FOUND'],
    [{ packageId: '' }, 400, 'INVALID_TERMS']
  ];
  for (const [terms, status, code] of cases) {
    const res = await post(admin, {
      firstName: 'Never',
      lastName: 'Made',
      email: 'never@register.test',
      membership: { packageId: String(monthly._id), ...terms }
    });
    assert.equal(res.statusCode, status, `${JSON.stringify(terms)} → ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, code, JSON.stringify(terms));
  }
  // The whole payment taken now is fine: exactly the total.
  const exact = await post(admin, {
    firstName: 'Paid',
    lastName: 'Exactly',
    email: 'exact@register.test',
    credentials: 'show',
    membership: { packageId: String(monthly._id), amountPaid: 7000 }
  });
  assert.equal(exact.statusCode, 201, JSON.stringify(exact.body));
  assert.equal(exact.body.order.payment.balanceDue, 0);

  assert.equal(await inGym(() => User.countDocuments({ email: 'never@register.test' })), 0);
  assert.equal(h.calls.emails.length, emailsBefore, 'nobody was emailed a password');
});

test('the registration date is today: a body naming another is refused', async () => {
  for (const field of ['joinedAt', 'createdAt', 'registrationDate']) {
    const res = await post(admin, { firstName: 'Back', lastName: 'Dated', phone: '0333 0000001', [field]: '2024-01-01' });
    assert.equal(res.statusCode, 400, field);
    assert.equal(res.body.code, 'REGISTRATION_DATE_LOCKED');
  }
  assert.equal(await inGym(() => User.countDocuments({ phone: '0333 0000001' })), 0);
});

test('permissions: users · manage at the gate, and package-orders · manage to sell the membership', async () => {
  // The route's gate refuses a role without users · manage.
  const gate = requirePermission('users', 'manage');
  const refused = await inGym(() => h.call(gate, { ...as(trainerStaff), method: 'POST', originalUrl: '/api/admin/members/register', body: {} }));
  assert.equal(refused.statusCode, 403);

  // Users · manage but only a view of memberships: may add the member, not sell to them.
  const selling = await post(clerk, {
    firstName: 'Clerk',
    lastName: 'Sale',
    phone: '0344 5556667',
    membership: { packageId: String(monthly._id) }
  });
  assert.equal(selling.statusCode, 403, JSON.stringify(selling.body));
  assert.match(selling.body.message, /package-orders/);
  assert.equal(await inGym(() => User.countDocuments({ phone: '0344 5556667' })), 0, 'nothing is created');

  const memberOnly = await post(clerk, { firstName: 'Clerk', lastName: 'Member', phone: '0344 5556668' });
  assert.equal(memberOnly.statusCode, 201, JSON.stringify(memberOnly.body));
  assert.equal(memberOnly.body.order, null);

  // Only members are registered here.
  const staffRole = await post(admin, { firstName: 'Not', lastName: 'Staff', phone: '0344 5556669', role: 'manager' });
  assert.equal(staffRole.statusCode, 400);
  assert.equal(staffRole.body.code, 'INVALID_ROLE');
});
