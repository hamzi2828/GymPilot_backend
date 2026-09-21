// A trainer who is also a staff account, in the desk's directory: listed once,
// as the account, answering to its own code and the trainer profile's; every
// other trainer and staff account exactly as before. Pure logic, no database
// -- the queries, punches and totals are in test/integration/trainerStaff.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { staffEntries } = require('../../src/attendance/services/peopleDirectory');

const oid = () => new mongoose.Types.ObjectId();

// Rows as the directory's queries return them (lean).
const tomAccount = { _id: oid(), firstName: 'Tom', lastName: 'Trainer', email: 'tom@gym.test', staffCode: 'TR-0010', employment: { jobTitle: 'Personal Trainer' } };
const tomProfile = { _id: oid(), name: 'Tom T.', role: 'Coach', staffCode: 'TR-0011', userId: tomAccount._id };
const rita = { _id: oid(), firstName: 'Rita', lastName: 'Reception', email: 'rita@gym.test', staffCode: 'TR-0003', employment: { jobTitle: 'Reception' } };
const una = { _id: oid(), name: 'Una Unlinked', role: 'Visiting coach', staffCode: 'TR-0020', userId: null };
// Linked to an account that is not a live staff account (a member, or one
// switched off): not in `accounts`, so still a trainer of their own.
const mona = { _id: oid(), name: 'Mona Member-Coach', role: 'Coach', staffCode: 'TR-0030', userId: oid() };

const byId = (entries, row) => entries.filter((entry) => entry.id === String(row._id));

test('a linked trainer is listed once, as the staff account, answering to both codes', () => {
  const entries = staffEntries([tomProfile, una], [tomAccount, rita], [tomAccount]);

  assert.equal(byId(entries, tomProfile).length, 0, 'the trainer profile is not listed');
  const [tom] = byId(entries, tomAccount);
  assert.deepEqual(
    { person_type: tom.person_type, name: tom.name, code: tom.code, meta: tom.meta },
    { person_type: 'staff', name: 'Tom Trainer', code: 'TR-0010', meta: 'Personal Trainer' }
  );
  assert.deepEqual(tom.codes, ['TR-0010', 'TR-0011']);
  assert.equal(byId(entries, tomAccount).length, 1, 'once, although both queries found the account');
});

test('found only through the trainer profile, the account is still listed -- by its own code, or the profile\'s until it has one', () => {
  // A search for "TR-0011": only the trainer profile matched it.
  const [tom] = staffEntries([tomProfile], [], [tomAccount]);
  assert.equal(tom.id, String(tomAccount._id));
  assert.equal(tom.code, 'TR-0010');
  assert.ok(tom.codes.includes('TR-0011'));

  const uncoded = { ...tomAccount, staffCode: null };
  const [fresh] = staffEntries([tomProfile], [], [uncoded]);
  assert.equal(fresh.id, String(tomAccount._id));
  assert.equal(fresh.code, 'TR-0011');
});

test('unlinked trainers, trainers linked to nobody who can punch, and other staff are listed as before', () => {
  const entries = staffEntries([una, mona, tomProfile], [rita, tomAccount], [tomAccount]);

  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.name, entry.code, entry.meta]),
    [
      [String(mona._id), 'Mona Member-Coach', 'TR-0030', 'Coach'],
      [String(rita._id), 'Rita Reception', 'TR-0003', 'Reception'],
      [String(tomAccount._id), 'Tom Trainer', 'TR-0010', 'Personal Trainer'],
      [String(una._id), 'Una Unlinked', 'TR-0020', 'Visiting coach']
    ],
    'one row each, sorted by name'
  );
  assert.ok(entries.every((entry) => entry.person_type === 'staff' && typeof entry.id === 'string'));
  assert.deepEqual(byId(entries, una)[0].codes, ['TR-0020']);
});

test('with no linked trainers the list is the trainers and accounts, unchanged', () => {
  const entries = staffEntries([una], [rita], []);
  assert.deepEqual(entries.map((entry) => entry.id), [String(rita._id), String(una._id)]);
  assert.deepEqual(staffEntries([], [], []), []);
});
