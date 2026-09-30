process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';

// No database in unit tests: never try to build indexes or create collections.
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, mapHeaders } = require('../../src/controller/userImportController');

test('parseCsv handles quotes, escaped quotes, CRLF and a BOM', () => {
  const rows = parseCsv('﻿name,email\r\n"Doe, Jane",jane@x.com\r\n"Say ""hi""",hi@x.com\n\n');
  assert.deepEqual(rows, [
    ['name', 'email'],
    ['Doe, Jane', 'jane@x.com'],
    ['Say "hi"', 'hi@x.com']
  ]);
});

test('headers are matched loosely by name', () => {
  const map = mapHeaders(['First Name', 'SURNAME', 'E-mail', 'Mobile', 'Member ID', 'Package', 'Expiry']);
  assert.equal(map.firstName, 0);
  assert.equal(map.lastName, 1);
  assert.equal(map.email, 2);
  assert.equal(map.phone, 3);
  assert.equal(map.memberCode, 4);
  assert.equal(map.package, 5);
  assert.equal(map.endDate, 6);
});

test('the new columns are recognised by their usual names', () => {
  const { mapHeaders: map } = require('../../src/controller/userImportController');
  const columns = map(['Full Name', 'Mobile', 'Home Address', 'Joining Date', 'Status', 'Discount', 'Package']);
  assert.equal(columns.fullName, 0);
  assert.equal(columns.phone, 1);
  assert.equal(columns.address, 2);
  assert.equal(columns.joinedAt, 3);
  assert.equal(columns.active, 4);
  assert.equal(columns.discount, 5);
  assert.equal(columns.package, 6);
  assert.equal(map(['Name', 'Registration Date']).joinedAt, 1);
  assert.equal(map(['Name']).fullName, 0);
  // "Joined" stays the membership start it always was.
  assert.equal(map(['Joined']).startDate, 0);
});

test('a full name splits into a first word and the rest', () => {
  const { splitFullName } = require('../../src/controller/userImportController');
  assert.deepEqual(splitFullName('  Ayesha   Khan Malik '), { firstName: 'Ayesha', lastName: 'Khan Malik' });
  assert.deepEqual(splitFullName('Cher'), { firstName: 'Cher', lastName: '' });
  assert.deepEqual(splitFullName(''), { firstName: '', lastName: '' });
});

test('an active cell reads yes/no, active/inactive and 1/0; blank is active', () => {
  const { parseActive } = require('../../src/controller/userImportController');
  for (const yes of ['yes', 'Y', 'true', '1', 'Active', '']) assert.equal(parseActive(yes), true, yes);
  for (const no of ['no', 'N', 'false', '0', 'INACTIVE', 'disabled']) assert.equal(parseActive(no), false, no);
  assert.equal(parseActive('maybe'), null);
});
