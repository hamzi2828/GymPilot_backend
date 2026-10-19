// "Resend owner invite" / "Reset owner password" from the platform panel,
// against a real MongoDB. When the set-password email cannot be sent the
// answer carries the reason (`data.inviteError`) and -- for a resend, where
// no password was typed -- the set-password link itself
// (`data.setPasswordLink`), still working, for the super admin to pass on by
// WhatsApp. The link is in that answer only: never in a log line or the
// audit trail. When the email goes, both are null, and a self-serve signup
// for the gym stops saying the email never went.

const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers/harness');

let gyms;
let SuperAdmin;
let PlatformAuditLog;
let DemoRequest;
let User;
let gym;
let admin;

const OWNER = 'boss@invite-gym.test';
const FAILURE = 'Invalid login: 535 Authentication failed';

const test = h.suite(async () => {
  gyms = h.src('platform/controllers/gymsController');
  SuperAdmin = h.src('platform/models/superAdminModel');
  PlatformAuditLog = h.src('platform/models/platformAuditLogModel');
  DemoRequest = h.src('platform/models/demoRequestModel');
  User = h.src('models/user');
  admin = (await SuperAdmin.create({ name: 'Owner', email: 'owner@invite-platform.test', password: 'not-used-here' })).toObject();
  gym = await h.createGym('invite-gym', { name: 'Invite Gym' });
});

const ask = (body) => h.call(gyms.resetOwnerPassword, { superAdmin: admin, params: { id: String(gym._id) }, body, socket: {} });
const ownerRow = () => h.inGym(gym, () => User.findOne({ email: OWNER }).select('+passwordResetTokenHash passwordResetExpiresAt').lean());
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** Runs `fn` with console output captured, so a test can say what was logged. */
async function capturingLogs(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(saved)) console[name] = (...args) => lines.push(args.map(String).join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

test('a resend that cannot be emailed says why and hands over a working link, logged nowhere', async () => {
  h.setEmailFailure(FAILURE);
  let res;
  let lines;
  try {
    ({ result: res, lines } = await capturingLogs(() => ask({ email: OWNER })));
  } finally {
    h.setEmailFailure(null);
  }
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.inviteSent, false);
  assert.equal(res.body.data.inviteError, FAILURE);
  assert.deepEqual(res.body.warnings, ['Owner email could not be sent']);

  const link = new URL(res.body.data.setPasswordLink);
  assert.equal(link.host, 'invite-gym.test', "on the gym's own site");
  assert.equal(link.pathname, '/authentication');
  assert.equal(link.searchParams.get('mode'), 'reset');
  assert.equal(link.searchParams.get('email'), OWNER);
  const token = link.searchParams.get('token');
  assert.match(token, /^[0-9a-f]{64}$/);

  // Still working: the owner's account holds the token's hash, unexpired.
  const owner = await ownerRow();
  assert.equal(owner.passwordResetTokenHash, sha256(token));
  assert.ok(new Date(owner.passwordResetExpiresAt) > new Date());

  // Never written down anywhere else.
  assert.ok(lines.some((line) => line.includes(FAILURE)), 'the reason is logged');
  assert.ok(!lines.some((line) => line.includes(token)), 'the link is not');
  // record() does not wait for its write: poll for the row.
  let audit = [];
  for (const until = Date.now() + 5000; !audit.length && Date.now() < until; ) {
    audit = await PlatformAuditLog.find({ gymId: gym._id, action: 'gym_owner_invite_sent' }).lean();
    if (!audit.length) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(audit.length >= 1, 'the resend is audited');
  assert.ok(!JSON.stringify(audit).includes(token), 'nor audited');
});

test('a typed password needs no link: none is handed over, and the unsent one stops working', async () => {
  h.setEmailFailure(FAILURE);
  let res;
  try {
    res = await ask({ email: OWNER, password: 'a typed password 123' });
  } finally {
    h.setEmailFailure(null);
  }
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.passwordSet, true);
  assert.equal(res.body.data.inviteSent, false);
  assert.equal(res.body.data.inviteError, FAILURE);
  assert.equal(res.body.data.setPasswordLink, null);
  assert.equal((await ownerRow()).passwordResetTokenHash, null);
});

test('an invite that goes has no error and no link, and its signup stops saying it never went', async () => {
  const signup = await DemoRequest.create({
    kind: 'signup',
    name: 'Bo Ss',
    email: OWNER,
    gymName: 'Invite Gym',
    gymId: gym._id,
    status: 'converted',
    signup: { state: 'ready', inviteSent: false }
  });
  const before = h.calls.emails.length;
  const res = await ask({ email: OWNER });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.inviteSent, true);
  assert.equal(res.body.data.inviteError, null);
  assert.equal(res.body.data.setPasswordLink, null);
  assert.deepEqual(res.body.warnings, []);
  assert.equal(h.calls.emails.length, before + 1);
  assert.equal(h.calls.emails[h.calls.emails.length - 1].to, OWNER);
  assert.equal((await DemoRequest.findById(signup._id).lean()).signup.inviteSent, true);
});

test('a gym set up by hand from a signup records whether its owner was emailed, for the buyer to be told', async () => {
  for (const [slug, failure] of [['handmade-sent', null], ['handmade-unsent', FAILURE]]) {
    const signup = await DemoRequest.create({ kind: 'signup', name: 'Ann Owner', email: `ann@${slug}.test`, gymName: `Gym ${slug}`, signup: { state: 'awaiting_payment' } });
    h.setEmailFailure(failure);
    let res;
    try {
      res = await h.call(gyms.create, {
        superAdmin: admin,
        socket: {},
        body: {
          name: `Gym ${slug}`,
          owner: { firstName: 'Ann', lastName: 'Owner', email: `ann@${slug}.test`, password: 'correct-horse-battery' },
          domains: [`${slug}.localhost:3000`],
          demoRequestId: String(signup._id)
        }
      });
    } finally {
      h.setEmailFailure(null);
    }
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.ownerInviteSent, !failure);
    const after = await DemoRequest.findById(signup._id).lean();
    assert.equal(String(after.gymId), String(res.body.data.id || res.body.data._id));
    assert.equal(after.signup.inviteSent, !failure, slug);
  }
});
