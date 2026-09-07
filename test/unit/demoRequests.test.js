process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/gymwear';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const { validateDemoRequest } = require('../../src/platform/controllers/demoRequestsController');

test('a complete demo request is trimmed and normalised', () => {
  const result = validateDemoRequest({
    name: '  Aisha Khan ',
    email: ' Aisha@IronWorks.FIT ',
    phone: ' +44 7700 900000 ',
    gymName: 'Iron Works Fitness',
    gymSize: '100 – 500 members',
    country: 'Manchester, UK',
    message: 'We use spreadsheets today.',
    source: 'https://gympilot.app/#demo'
  });
  assert.equal(result.spam, false);
  assert.deepEqual(result.errors, []);
  assert.equal(result.data.name, 'Aisha Khan');
  assert.equal(result.data.email, 'aisha@ironworks.fit');
  assert.equal(result.data.phone, '+44 7700 900000');
  assert.equal(result.data.gymName, 'Iron Works Fitness');
});

test('name, a valid email and the gym name are required', () => {
  const result = validateDemoRequest({ email: 'not-an-email', message: 'hi' });
  assert.equal(result.spam, false);
  assert.deepEqual(result.errors, ['Your name is required', 'A valid email address is required', 'The gym name is required']);
});

test('a filled honeypot is spam, whatever else was sent', () => {
  const result = validateDemoRequest({ name: 'Bot', email: 'bot@example.com', gymName: 'Bots', website: 'http://spam.example' });
  assert.equal(result.spam, true);
  assert.equal(result.data, null);
});

test('over-long fields are cut, not rejected, and non-strings are ignored', () => {
  const result = validateDemoRequest({ name: 'A'.repeat(500), email: 'a@b.co', gymName: { nested: true }, message: 42 });
  assert.equal(result.data.name.length, 120);
  assert.equal(result.data.gymName, '');
  assert.equal(result.data.message, '');
  assert.deepEqual(result.errors, ['The gym name is required']);
});
