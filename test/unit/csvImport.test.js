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

/* ------------------------------- dates ---------------------------------- */

const { storage } = require('../../src/platform/tenantContext');
const { parseDate, dateProblem } = require('../../src/controller/userImportController');
const { dateSerial } = require('../../src/services/xlsx');

// A gym in Karachi (UTC+5): the 30th of September ends at 18:59:59.999Z.
const inKarachi = (fn) => storage.run({ gym: { _id: 'khi', slug: 'khi', locale: { timezone: 'Asia/Karachi' } } }, fn);
const END_OF_30_SEP = '2026-09-30T18:59:59.999Z';
const endOf = (cell) => {
  const d = parseDate(cell, 'end');
  return d ? d.toISOString() : null;
};

test('a date reads the same however a spreadsheet writes it, when it has only one reading', () =>
  inKarachi(() => {
    for (const cell of [
      '2026-09-30',
      '2026/09/30',
      '2026-9-30',
      '30/09/2026',
      '30-9-2026',
      '30.09.2026',
      '30 Sep 2026',
      '30-Sep-2026',
      '30 September 2026',
      '30th Sept 2026',
      'Sep 30, 2026',
      'September 30 2026',
      'SEP 30 2026',
      // ISO with a time of day and no zone: the gym's own clock, so the day written.
      '2026-09-30 00:00:00',
      '2026-09-30T14:30',
      '2026-09-30 23:59:59.000',
      // Midnight UTC is how a plain date is exported.
      '2026-09-30T00:00:00.000Z'
    ]) {
      assert.equal(endOf(cell), END_OF_30_SEP, cell);
    }
    assert.equal(parseDate('1 Jan 2026', 'start').toISOString(), '2025-12-31T19:00:00.000Z');
  }));

test('a spreadsheet serial number is the day it stands for', () =>
  inKarachi(() => {
    assert.equal(dateSerial('2026-09-30'), 46295);
    assert.equal(endOf('46295'), END_OF_30_SEP);
    // A date cell with a time in it exports with a fraction.
    assert.equal(endOf('46295.75'), END_OF_30_SEP);
    assert.equal(parseDate(String(dateSerial('1990-05-14'))).toISOString(), '1990-05-14T07:00:00.000Z');
    // Not a serial: a bare year, a phone-like number.
    assert.equal(parseDate('2026'), null);
    assert.equal(parseDate('3001234567'), null);
  }));

test('a timestamp that names its own zone keeps its instant', () =>
  inKarachi(() => {
    assert.equal(endOf('2026-09-30T10:15:00Z'), '2026-09-30T10:15:00.000Z');
    assert.equal(endOf('2026-09-30 10:15:00+05:00'), '2026-09-30T05:15:00.000Z');
  }));

test('a date with more than one reading, or none, is not guessed at', () =>
  inKarachi(() => {
    for (const cell of [
      '09/30/2026', // month first: there is no month 30
      '30/09/26', // which century?
      '30-Sep-26',
      'Sep 2026',
      '30 Sepember 2026',
      '31/02/2026',
      '31 Feb 2026',
      '2026-02-31',
      'next month',
      'n/a'
    ]) {
      assert.equal(parseDate(cell, 'end'), null, cell);
    }
    // Day first, as the template says -- never turned round to fit.
    assert.equal(parseDate('03/04/2026', 'start').toISOString(), '2026-04-02T19:00:00.000Z');
  }));

test('an unreadable date says which cell, what was in it and how to write it', () => {
  assert.equal(
    dateProblem('membership end date', 'end of Sept'),
    'Could not read the membership end date "end of Sept". Write dates as 2026-09-30 or 30/09/2026 (day first)'
  );
  assert.equal(
    dateProblem('membership end date', '09/30/2026'),
    'Could not read the membership end date "09/30/2026". It looks like month/day/year, and dates are read day first: write it as 30/09/2026'
  );
  assert.equal(
    dateProblem('membership start date', '30/09/26'),
    'Could not read the membership start date "30/09/26". Write the year in full, like 30/09/2026 or 2026-09-30'
  );
});

/* ---------------------------- the time budget ---------------------------- */

test('an import stops starting rows after 40 seconds unless IMPORT_BUDGET_MS says otherwise', () => {
  const { importBudgetMs } = require('../../src/controller/userImportController');
  assert.equal(importBudgetMs({}), 40000);
  assert.equal(importBudgetMs({ IMPORT_BUDGET_MS: '240000' }), 240000);
  for (const bad of ['', '0', '-5', 'soon']) assert.equal(importBudgetMs({ IMPORT_BUDGET_MS: bad }), 40000, bad);
});

test('a run that stopped says how much is left and to upload the same file again', () => {
  const { stoppedNote } = require('../../src/controller/userImportController');
  assert.equal(
    stoppedNote({ dryRun: false, remaining: 4786 }),
    'Stopped before the time limit with 4786 row(s) still to do. Upload the same file again to carry on — members already imported are skipped, so nobody is added twice.'
  );
  assert.match(stoppedNote({ dryRun: true, remaining: 12 }), /^The preview stopped before the time limit: 12 row\(s\) were not checked\./);
});
