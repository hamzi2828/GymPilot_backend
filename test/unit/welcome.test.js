// The welcome email a member gets when they make their own account: it
// carries the username the phone app signs in with, but only at a gym that
// has the app (the `member-app` add-on); a Google account is told how to set
// the password the app needs. Email, the gym's templates and the entitlement
// check are stubbed, so nothing leaves the machine and no database is needed.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

// Installed before gymNotifications is loaded: it takes sendEmail by name.
const emailService = require('../../src/services/emailService');
const sent = [];
emailService.sendEmail = async (to, subject, html) => {
  sent.push({ to, subject, html });
  return { success: true };
};

const templates = require('../../src/services/templateService');
const entitlements = require('../../src/platform/entitlements');
const { storage } = require('../../src/platform/tenantContext');
const notify = require('../../src/services/gymNotifications');
const t = require('../../src/templates/gymEmails');

const realRenderEmail = templates.renderEmail;
const realRenderText = templates.renderText;
const realHasAddon = entitlements.gymHasAddon;

// No gym wording and no text channels, unless a test says otherwise.
templates.renderEmail = async () => null;
templates.renderText = async () => '';

test.after(() => {
  templates.renderEmail = realRenderEmail;
  templates.renderText = realRenderText;
  entitlements.gymHasAddon = realHasAddon;
});

const gym = { _id: 'gym-welcome', slug: 'iron-works', plan: 'plan-basic', subscription: { addons: [] } };
const member = () => ({
  _id: 'user-1',
  firstName: 'Sara',
  lastName: 'Malik',
  email: 'sara@iron.test',
  username: 'saramalik284',
  phone: null,
  notificationPreferences: {}
});

// Runs fn as a request for the gym would, with the member app on or off.
async function send(appEnabled, fn) {
  const asked = [];
  entitlements.gymHasAddon = async (g, slug) => {
    asked.push({ gym: g && g.slug, slug });
    return appEnabled;
  };
  sent.length = 0;
  const result = await storage.run({ gym, origin: 'https://iron.test' }, async () => {
    // Quietly: the Settings lookup has no database here and falls back.
    const warn = console.error;
    console.error = () => {};
    try {
      notify.resetBrandCache();
      return await fn();
    } finally {
      console.error = warn;
    }
  });
  return { result, asked, emails: sent.slice() };
}

test('the template alone: username and the app, only when given one', () => {
  const plain = t.memberWelcome({ firstName: 'Sara', siteName: 'Iron Works', timetableUrl: 'https://iron.test/classes' });
  assert.equal(plain.subject, 'Welcome to Iron Works');
  assert.doesNotMatch(plain.html, /Username|App Store/);

  const withApp = t.memberWelcome({ firstName: 'Sara', siteName: 'Iron Works', username: 'saramalik284' });
  assert.match(withApp.html, /saramalik284/);
  assert.match(withApp.html, /App Store or Google Play/);
  assert.match(withApp.html, /the password you chose/);
  assert.doesNotMatch(withApp.html, /Forgot password/);

  const google = t.memberWelcome({ firstName: 'Sara', siteName: 'Iron Works', username: 'saramalik284', needsPassword: true });
  assert.match(google.html, /Forgot password/);
  assert.doesNotMatch(google.html, /the password you chose/);

  // The username is the member's own text; it is escaped like the rest.
  const odd = t.memberWelcome({ firstName: 'Sara', username: '<b>x</b>' });
  assert.doesNotMatch(odd.html, /<b>x<\/b>/);
});

test('a gym with the member app: the welcome carries the username and how to get the app', async () => {
  const { result, asked, emails } = await send(true, () => notify.memberWelcome(member()));
  assert.equal(result.success, true);
  assert.deepEqual(asked, [{ gym: 'iron-works', slug: 'member-app' }]);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'sara@iron.test');
  assert.match(emails[0].html, /saramalik284/);
  assert.match(emails[0].html, /App Store or Google Play/);
  assert.match(emails[0].html, /https:\/\/iron\.test\/classes/);
});

test('a gym without the member app: a plain welcome, no username, no app', async () => {
  const { emails } = await send(false, () => notify.memberWelcome(member()));
  assert.equal(emails.length, 1);
  assert.doesNotMatch(emails[0].html, /saramalik284|App Store/);
});

test('a Google sign-up is told to set a password for the app', async () => {
  const { emails } = await send(true, () => notify.memberWelcome(member(), { viaGoogle: true }));
  assert.match(emails[0].html, /saramalik284/);
  assert.match(emails[0].html, /Forgot password/);
});

test('an entitlement check that fails means no app in the email, and the welcome still goes', async () => {
  entitlements.gymHasAddon = async () => {
    throw new Error('platform database unreachable');
  };
  sent.length = 0;
  await storage.run({ gym, origin: 'https://iron.test' }, async () => {
    const warn = console.error;
    console.error = () => {};
    try {
      await notify.memberWelcome(member());
    } finally {
      console.error = warn;
    }
  });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].html, /saramalik284/);
});

test('a gym\'s own welcome wording can use {{username}}', async () => {
  let vars = null;
  templates.renderEmail = async (key, v) => {
    vars = v;
    return { subject: 'Hello', html: `<p>${v.username}</p>` };
  };
  try {
    const { emails } = await send(true, () => notify.memberWelcome(member()));
    assert.equal(vars.username, 'saramalik284');
    assert.equal(emails[0].html, '<p>saramalik284</p>');
  } finally {
    templates.renderEmail = async () => null;
  }
});
