// services/csv.js: a negative amount stays a number Excel can add up, while
// anything else starting with a formula character is still neutralised.

const test = require('node:test');
const assert = require('node:assert/strict');

const { toCsv } = require('../../src/services/csv');

test('negative numbers are written as numbers; formula-like text is still neutralised', () => {
  const csv = toCsv(
    [{ key: 'v', label: 'Value' }],
    [{ v: -40 }, { v: '-12.5' }, { v: '-1+1' }, { v: '-SUM(A1)' }, { v: '+44 20 7946 0000' }, { v: '@cmd' }, { v: 0 }]
  );
  assert.deepEqual(csv.replace(/^﻿/, '').split('\r\n').slice(1, 8), ['-40', '-12.5', "'-1+1", "'-SUM(A1)", "'+44 20 7946 0000", "'@cmd", '0']);
});
