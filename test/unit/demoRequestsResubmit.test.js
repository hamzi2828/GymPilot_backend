// Sending checkout again within the duplicate window: the second answers
// replace the first on the same record -- every field, not just the plan --
// and nobody is emailed twice. No database: the model's lookups are stubbed.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const DemoRequest = require('../../src/platform/models/demoRequestModel');
const controller = require('../../src/platform/controllers/demoRequestsController');

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('a resubmission updates the name, gym and phone it corrected, not only the plan', async () => {
  const saved = [];
  const recent = {
    _id: new mongoose.Types.ObjectId(),
    kind: 'trial',
    email: 'aisha@ironworks.fit',
    name: 'Aisha Kahn',
    firstName: 'Aisha',
    lastName: 'Kahn',
    phone: '+92 300 0000000',
    gymName: 'Iron Wroks',
    country: '',
    message: 'first try',
    preferredSlug: 'iron-wroks',
    set(fields) {
      Object.assign(this, fields);
    },
    async save() {
      saved.push({ ...this });
    }
  };
  DemoRequest.findOne = async () => recent;
  DemoRequest.create = async () => assert.fail('a resubmission must not create a second record');

  const res = fakeRes();
  await controller.submit(
    {
      body: {
        kind: 'trial',
        firstName: 'Aisha',
        lastName: 'Khan',
        email: 'Aisha@IronWorks.fit',
        phone: '+92 300 1234567',
        gymName: 'Iron Works',
        country: 'Karachi, Pakistan',
        message: 'second try',
        preferredSlug: 'iron-works'
      },
      headers: {},
      socket: {}
    },
    res
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.id, String(recent._id));
  assert.equal(saved.length, 1);
  assert.equal(recent.name, 'Aisha Khan');
  assert.equal(recent.lastName, 'Khan');
  assert.equal(recent.phone, '+92 300 1234567');
  assert.equal(recent.gymName, 'Iron Works');
  assert.equal(recent.country, 'Karachi, Pakistan');
  assert.equal(recent.message, 'second try');
  assert.equal(recent.preferredSlug, 'iron-works');
});
