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
