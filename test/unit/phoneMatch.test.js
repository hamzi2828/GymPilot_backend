// One phone number however it was typed (services/phoneMatch.js), and the
// searches that use it: the fee desk and the header search. Pure logic, no
// database.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../../src/services/phoneMatch');

const FORMS = ['0301-1234567', '03011234567', '+923011234567', '+92 301 1234567', '0092 301 1234567', '923011234567', '(0301) 123-4567', '+92 0301 1234567'];

test('every way the desk types a Pakistani mobile has the same core', () => {
  for (const form of FORMS) assert.equal(P.phoneCore(form), '3011234567', form);
  assert.equal(P.phoneCore(''), '');
  assert.equal(P.phoneCore(null), '');
  // Another country keeps its code: it only matches itself.
  assert.equal(P.phoneCore('+44 7700 900123'), '447700900123');
});

test('the same number in any form is the same; one digit apart is not', () => {
  for (const a of FORMS) for (const b of FORMS) assert.ok(P.samePhone(a, b), `${a} = ${b}`);
  assert.equal(P.samePhone('0301-1234567', '0301-1234568'), false);
  assert.equal(P.samePhone('123', '123'), false, 'too short to be one person\'s number');

  const rx = P.samePhonePattern('+92 301 1234567');
  for (const stored of FORMS) assert.ok(rx.test(stored), stored);
  for (const other of ['0301-12345678', '0301-1234568', '13011234567', '0300-1234567']) assert.equal(rx.test(other), false, other);
  assert.equal(P.samePhonePattern('12345'), null);
});

test('a search for part of a number finds it in every stored form', () => {
  for (const term of ['+92301', '0301-123', '0301123', '301 1234', '+92 301 1234567', '03011234567']) {
    const rx = P.phoneSearchPattern(term);
    assert.ok(rx, term);
    for (const stored of FORMS) assert.ok(rx.test(stored), `${term} finds ${stored}`);
  }
  assert.equal(P.phoneSearchPattern('ava'), null);
  assert.equal(P.phoneSearchPattern('123'), null, 'four digits at least');
  assert.equal(P.phoneSearchPattern('0301 a'), null);
});

test('the fee desk and the header search match a phone in any form', () => {
  const feeDesk = require('../../src/gymfolio/services/feeDesk');
  assert.ok(feeDesk.phonePattern('+923011234567').test('0301-1234567'));
  assert.ok(feeDesk.phonePattern('0301-1234567').test('+92 301 1234567'));

  const search = require('../../src/controller/adminSearchController');
  const members = search.GROUPS.find((g) => g.key === 'members');
  const filter = search.groupFilter(members, ['+923011234567']);
  assert.equal(filter.role, 'user');
  assert.ok(filter.$or.some((alt) => alt.phone instanceof RegExp && alt.phone.test('0301-1234567')));
  const orders = search.GROUPS.find((g) => g.key === 'orders');
  assert.ok(search.groupFilter(orders, ['0301', '1234567']).$or.some((alt) => alt['customerInfo.phone'] && alt['customerInfo.phone'].test('+92 301 1234567')));
  // Words stay words.
  assert.ok(Array.isArray(search.groupFilter(members, ['jo']).$and));
  const classes = search.GROUPS.find((g) => g.key === 'classes');
  assert.equal(search.groupFilter(classes, ['0301-1234567']).$or, undefined, 'no phone field, no phone match');
});
