// The one email check the models share (src/helper/emailShape.js): linear
// time whatever it is fed -- the public contact and newsletter forms used a
// pattern a 40-character string could hold for minutes -- and long top-level
// domains (.info, .fitness) are addresses like any other. No database: the
// models are only validated.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { isEmailShape, emailValidator, MAX_LENGTH } = require('../../src/helper/emailShape');
const { runWithTenant } = require('../../src/platform/tenantContext');
const Contact = require('../../src/models/contactModel');
const Newsletter = require('../../src/models/newsletterModel');
const Author = require('../../src/models/authorModel');
const Trainer = require('../../src/gymfolio/models/trainerModel');
const PackageRegistration = require('../../src/gymfolio/models/packageRegistrationModel');

const gym = { _id: '00000000000000000000e001', slug: 'unit-email-shape', database: { name: 'gympilot_unit_email_shape' } };

// What made the old pattern backtrack: a long run that nearly matches, then
// a character that does not. Each is checked well inside a millisecond now.
const HOSTILE = [
  `${'a'.repeat(40)}!`,
  `${'a.'.repeat(5000)}@`,
  `a@${'a-'.repeat(5000)}!`,
  `${'a'.repeat(30)}@${'a'.repeat(30)}${'.a'.repeat(30)}!`,
  `${'x'.repeat(100000)}@gym.com`,
  `a@${'b.'.repeat(120)}c`
];

test('a hostile address is answered at once, not after the event loop has been held', () => {
  for (const input of HOSTILE) {
    const started = process.hrtime.bigint();
    const result = isEmailShape(input);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result, false, input.slice(0, 40));
    assert.ok(ms < 5, `${input.slice(0, 20)}... took ${ms.toFixed(2)} ms`);
  }
});

test('ordinary addresses pass, long top-level domains included', () => {
  for (const ok of ['x@gym.info', 'a@b.fitness', 'sam@gym.test', 'first.last+tag@mail.example.co.uk', "o'brien@gym.ie", 'a_b-c@sub-domain.gym.com', 'A@B.CO']) {
    assert.equal(isEmailShape(ok), true, ok);
  }
});

test('anything that is not one address is refused', () => {
  for (const bad of [
    '', ' ', 'plain', '@gym.com', 'sam@', 'sam@gym', 'sam@gym.c', 'sam@gym.c0m', 'sam@@gym.com', 'a@b@gym.com',
    'sam @gym.com', 'sam@gym .com', '.sam@gym.com', 'sam.@gym.com', 'sa..m@gym.com', 'sam@.gym.com', 'sam@gym..com',
    'sam@-gym.com', 'sam@gym-.com', '<sam>@gym.com', 'sam@gym.com>', 'a,b@gym.com', 'sam@gym.com\n', `${'a'.repeat(65)}@gym.com`,
    `a@${'b'.repeat(64)}.com`, `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`, null, undefined, 42, {}
  ]) {
    assert.equal(isEmailShape(bad), false, JSON.stringify(bad));
  }
  assert.equal(`${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`.length > MAX_LENGTH, true);
});

test('as a model validator an empty value is left to `required`', () => {
  const { validator } = emailValidator();
  for (const empty of [undefined, null, '']) assert.equal(validator(empty), true);
  assert.equal(validator('x@gym.info'), true);
  assert.equal(validator('nope'), false);
});

test('the contact, newsletter, author, trainer and package registration models all use it', async () => {
  await runWithTenant(gym, async () => {
    const cases = [
      [Contact, 'emailAddress', { fullName: 'Sam', message: 'Hello' }, 'Please provide a valid email address'],
      [Newsletter, 'email', {}, 'Please enter a valid email'],
      [Author, 'email', { name: 'Sam' }, 'Please enter a valid email'],
      [Trainer, 'email', {}, 'Please enter a valid email'],
      // The public "register for a package" form.
      [PackageRegistration, 'email', {}, 'Please provide a valid email address']
    ];
    for (const [Model, field, rest, message] of cases) {
      for (const ok of ['x@gym.info', 'a@b.fitness', '  Sam@Gym.Fitness  ']) {
        const doc = new Model({ ...rest, [field]: ok });
        const error = doc.validateSync([field]);
        assert.equal(error && error.errors[field] ? error.errors[field].message : null, null, `${Model.modelName} ${ok}`);
      }
      for (const bad of ['not an email', HOSTILE[0]]) {
        const started = Date.now();
        const error = new Model({ ...rest, [field]: bad }).validateSync([field]);
        assert.ok(Date.now() - started < 50, `${Model.modelName} answered at once`);
        assert.equal(error.errors[field].message, message, `${Model.modelName} ${bad}`);
      }
    }
  });
});
