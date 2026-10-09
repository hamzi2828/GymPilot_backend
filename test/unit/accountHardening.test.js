// Sign-up, sign-in and account-change rules that are decided before any
// database is touched. Pure logic: a request that reached a model here would
// throw (no tenant context), so a clean answer proves where the refusal was.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const users = require('../../src/controller/userController');
const { MIN_PASSWORD_LENGTH, passwordProblem } = require('../../src/services/adminPasswords');

/** A res that records what it was told. */
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

async function call(handler, req) {
  const res = fakeRes();
  await handler({ headers: {}, query: {}, params: {}, body: {}, ...req }, res);
  return res;
}

const signUp = (password, extra = {}) =>
  call(users.createUser, { body: { firstName: 'Sam', lastName: 'Short', email: 'sam@gym.test', password, ...extra } });

test('sign-up holds a password to the rule a reset and a change are held to', async () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  for (const password of ['a', '1234567', 'x'.repeat(201)]) {
    const res = await signUp(password);
    assert.equal(res.statusCode, 400, password.slice(0, 12));
    assert.equal(res.body.message, passwordProblem(password));
  }
  assert.match((await signUp('1234567')).body.message, /at least 8 characters/);
  // Checked with the confirmation, before the address is looked up.
  assert.equal((await signUp('1234567', { confirmPassword: '1234567' })).statusCode, 400);
  // A length and nothing else: no rule about digits or symbols.
  assert.equal(passwordProblem('aaaaaaaa'), null);
});

test('the reset and welcome emails carry a name as text, never as markup', () => {
  const { welcomeEmailHtml, passwordResetEmailHtml } = users.emailTemplates;
  const hostile = '<a href="https://evil.test/login">Click here to keep your account</a>';

  const reset = passwordResetEmailHtml({
    firstName: hostile,
    siteName: 'Iron <b>Works</b>',
    resetUrl: 'https://gym.test/authentication?mode=reset&token=abc&email=a%40b.test',
    validMinutes: 60
  });
  assert.equal(reset.includes('evil.test/login">'), false, 'the attacker has no link in the email');
  assert.equal(reset.includes('<b>'), false);
  assert.ok(reset.includes('&lt;a href=&quot;https://evil.test/login&quot;&gt;'), 'the name is shown as it was typed');
  // The gym's own link is the only one, and still works as a link.
  assert.equal(reset.match(/<a /g).length, 1);
  assert.ok(reset.includes('href="https://gym.test/authentication?mode=reset&amp;token=abc&amp;email=a%40b.test"'));

  const welcome = welcomeEmailHtml({
    firstName: hostile,
    email: 'a@b.test',
    username: 'ann<i>123',
    password: 'p<w>&"\'',
    siteName: 'Iron <b>Works</b>',
    loginUrl: 'https://gym.test/authentication'
  });
  assert.equal(welcome.match(/<a /g).length, 1);
  for (const raw of ['evil.test/login">', '<b>', '<i>', '<w>']) assert.equal(welcome.includes(raw), false, raw);
  assert.ok(welcome.includes('p&lt;w&gt;&amp;&quot;&#39;'), 'a password with symbols reads back exactly');
});
