// The platform panel's sessions: a token is good only for the generation it
// was signed under, which a password change, a password reset and a sign-out
// each move on. Also: the sign-in code stays out of the email's subject, and
// a reset link is only ever built on PLATFORM_ADMIN_ORIGIN. No database and
// no mail server: the model statics and sendEmail are stood in for.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
process.env.PLATFORM_JWT_SECRET = 'unit-test-platform-secret';
delete process.env.PLATFORM_ADMIN_ORIGIN;
delete process.env.FRONTEND_ORIGIN;
delete process.env.GYMFOLIO_URL;
delete process.env.SUPER_ADMIN_EMAIL;

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Before the controller is loaded: it keeps its own reference to sendEmail.
const emails = [];
const emailService = require('../../src/services/emailService');
emailService.sendEmail = async (to, subject, html) => {
  emails.push({ to, subject, html });
  return { success: true };
};

const SuperAdmin = require('../../src/platform/models/superAdminModel');
const PlatformAuditLog = require('../../src/platform/models/platformAuditLogModel');
const { platformAuth, signPlatformToken } = require('../../src/platform/middleware/platformAuth');
const controller = require('../../src/platform/controllers/platformAuthController');

PlatformAuditLog.record = async () => null;

function stub(target, methods) {
  const saved = {};
  for (const [name, fn] of Object.entries(methods)) {
    saved[name] = target[name];
    target[name] = fn;
  }
  return () => {
    for (const [name, fn] of Object.entries(saved)) target[name] = fn;
  };
}

async function withEnv(values, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A super admin as the model hands one back: fields and save(). */
async function adminDoc(fields = {}) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Olga Owner',
    email: 'olga@gympilot.test',
    password: await bcrypt.hash('the old password', 4),
    isActive: true,
    twoFactor: { enabled: false, pending: null },
    passwordReset: { tokenHash: null, expiresAt: null },
    ...fields,
    saves: 0
  };
  doc.save = async () => {
    doc.saves += 1;
    return doc;
  };
  return doc;
}

/** The one account every lookup finds, however it is asked for. */
function accountIs(admin) {
  const found = () => {
    const q = { select: () => q, lean: () => q, then: (resolve, reject) => Promise.resolve(admin).then(resolve, reject) };
    return q;
  };
  return stub(SuperAdmin, {
    findById: found,
    findOne: found,
    updateOne: async (filter, update) => {
      if (update.$inc && update.$inc.tokenVersion) admin.tokenVersion = (admin.tokenVersion || 0) + update.$inc.tokenVersion;
      return { matchedCount: 1 };
    }
  });
}

function fakeRes() {
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

/** Runs the panel's auth middleware with a token; resolves 'next' or the refusal. */
async function present(token) {
  const res = fakeRes();
  let passed = false;
  await platformAuth({ headers: { authorization: `Bearer ${token}` } }, res, () => {
    passed = true;
  });
  return passed ? 'next' : res;
}

const call = async (handler, req) => {
  const res = fakeRes();
  await handler({ headers: {}, body: {}, socket: {}, ...req }, res);
  return res;
};

test('a token is good only for the generation of sessions it was signed under', async () => {
  const admin = await adminDoc();
  const restore = accountIs(admin);
  try {
    const token = signPlatformToken(admin);
    assert.equal(jwt.decode(token).tv, 0);
    assert.equal(await present(token), 'next');

    admin.tokenVersion = 1;
    const refused = await present(token);
    assert.equal(refused.statusCode, 401);
    assert.match(refused.body.message, /session has ended/);
    assert.equal(await present(signPlatformToken(admin)), 'next');

    // A token from before versions existed carries none: good until the account's first change.
    const legacy = jwt.sign({ sid: String(admin._id), email: admin.email, scope: 'platform' }, 'unit-test-platform-secret', { expiresIn: '12h' });
    assert.equal((await present(legacy)).statusCode, 401);
    delete admin.tokenVersion;
    assert.equal(await present(legacy), 'next');
  } finally {
    restore();
  }
});

test('changing the password signs every other session out, and hands this one a new token', async () => {
  const admin = await adminDoc();
  const restore = accountIs(admin);
  try {
    const before = signPlatformToken(admin);
    const res = await call(controller.changePassword, { superAdmin: admin, body: { currentPassword: 'the old password', newPassword: 'a brand new password' } });
    assert.equal(res.statusCode, 200);
    assert.equal(admin.tokenVersion, 1);
    assert.equal(await bcrypt.compare('a brand new password', admin.password), true);
    assert.equal((await present(before)).statusCode, 401, 'the token signed under the old password is over');
    assert.equal(await present(res.body.token), 'next', 'the one in the answer carries on');
  } finally {
    restore();
  }
});

test('resetting the password by email signs every session out', async () => {
  const crypto = require('crypto');
  const token = 'a'.repeat(64);
  const admin = await adminDoc({ tokenVersion: 3, passwordReset: { tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60000) } });
  const restore = accountIs(admin);
  try {
    const before = signPlatformToken(admin);
    const res = await call(controller.resetPassword, { body: { email: admin.email, token, password: 'a brand new password' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(admin.tokenVersion, 4);
    assert.equal(admin.passwordReset.tokenHash, null);
    assert.equal((await present(before)).statusCode, 401);
  } finally {
    restore();
  }
});

test('signing out ends the session on the server, not just in the browser', async () => {
  const admin = await adminDoc();
  const restore = accountIs(admin);
  try {
    const token = signPlatformToken(admin);
    assert.equal(await present(token), 'next');
    const res = await call(controller.logout, { superAdmin: admin });
    assert.equal(res.statusCode, 200);
    assert.equal((await present(token)).statusCode, 401);
  } finally {
    restore();
  }
});

test('the sign-in code is in the email, never in its subject', async () => {
  const admin = await adminDoc({ twoFactor: { enabled: true, pending: null } });
  const restore = accountIs(admin);
  emails.length = 0;
  try {
    const res = await call(controller.login, { body: { email: admin.email, password: 'the old password' } });
    assert.equal(res.body.requires2fa, true, JSON.stringify(res.body));
    assert.equal(emails.length, 1);
    assert.doesNotMatch(emails[0].subject, /\d/, 'subjects are logged, and shown on a locked phone');
    assert.match(emails[0].html, />\d{6}</);
  } finally {
    restore();
  }
});

test('a reset link is built on PLATFORM_ADMIN_ORIGIN and nowhere else, whatever site asked', async () => {
  const admin = await adminDoc();
  const restore = accountIs(admin);
  // A gym's own domain: a registered, trusted origin for everything else.
  const fromGymSite = { headers: { origin: 'https://ironworks.example' }, body: { email: admin.email } };
  try {
    assert.equal(controller.panelOrigin({}), null);
    assert.equal(controller.panelOrigin({ PLATFORM_ADMIN_ORIGIN: ' https://gympilot.app/ , https://www.gympilot.app' }), 'https://gympilot.app');
    assert.equal(controller.panelOrigin({ PLATFORM_ADMIN_ORIGIN: 'gympilot.app' }), null, 'not an origin');

    // Not set: no link, no token, and the answer says so whoever asked.
    emails.length = 0;
    await withEnv({ PLATFORM_ADMIN_ORIGIN: undefined, FRONTEND_ORIGIN: 'https://ironworks.example' }, async () => {
      const res = await call(controller.forgotPassword, fromGymSite);
      assert.equal(res.statusCode, 503);
      assert.match(res.body.message, /not set up on this server/);
      assert.equal(emails.length, 0);
      assert.equal(admin.passwordReset.tokenHash, null);
    });

    await withEnv({ PLATFORM_ADMIN_ORIGIN: 'https://gympilot.app,https://www.gympilot.app' }, async () => {
      const res = await call(controller.forgotPassword, fromGymSite);
      assert.equal(res.statusCode, 200);
      assert.equal(emails.length, 1);
      assert.match(emails[0].html, /https:\/\/gympilot\.app\/reset\?token=[0-9a-f]{64}/);
      assert.doesNotMatch(emails[0].html, /ironworks\.example/);
    });
  } finally {
    restore();
  }
});
