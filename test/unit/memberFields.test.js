// The profile details taken down while creating a member: what is kept, in
// which shape, and what is refused. Pure, no database.
const test = require('node:test');
const assert = require('node:assert/strict');

const { profileFieldsFrom, primaryAddress } = require('../../src/services/memberFields');

const NOW = new Date('2026-09-30T12:00:00Z');

test('blank details are left out entirely', () => {
  assert.deepEqual(profileFieldsFrom({}, NOW), { fields: {} });
  assert.deepEqual(profileFieldsFrom({ gender: '', dateOfBirth: null, address: '   ', staffNotes: undefined }, NOW), { fields: {} });
});

test('each detail lands where the rest of the account keeps it', () => {
  const { fields } = profileFieldsFrom(
    { gender: 'Female', dateOfBirth: '1990-05-14', address: '12 Mall Road,\r\nLahore', staffNotes: '  Knee injury in March ' },
    NOW
  );
  assert.equal(fields.gender, 'female');
  assert.equal(fields.dateOfBirth.toISOString().slice(0, 10), '1990-05-14');
  // One line, as the primary entry of the account's own address book.
  assert.deepEqual(fields.addresses, [{ label: 'primary', isDefault: true, address: '12 Mall Road, Lahore' }]);
  assert.equal(fields.staffNotes, 'Knee injury in March');
});

test('a date of birth must be a real date and not in the future', () => {
  assert.match(profileFieldsFrom({ dateOfBirth: 'next tuesday' }, NOW).problem, /not a date/);
  assert.match(profileFieldsFrom({ dateOfBirth: '2027-01-01' }, NOW).problem, /future/);
});

test('oversized or oddly shaped details are refused, not cut', () => {
  assert.match(profileFieldsFrom({ gender: 'x'.repeat(21) }, NOW).problem, /Gender/);
  assert.match(profileFieldsFrom({ address: 'x'.repeat(301) }, NOW).problem, /Address/);
  assert.match(profileFieldsFrom({ address: { street: '12 Mall Road' } }, NOW).problem, /one line/);
  assert.match(profileFieldsFrom({ staffNotes: 'x'.repeat(10001) }, NOW).problem, /too long/);
});

test('the address a record shows is the default one, else the primary, else the first', () => {
  assert.equal(primaryAddress({ addresses: [{ label: 'secondary', address: 'B' }, { label: 'primary', isDefault: true, address: 'A' }] }), 'A');
  assert.equal(primaryAddress({ addresses: [{ label: 'secondary', address: 'B' }, { label: 'primary', address: 'A' }] }), 'A');
  assert.equal(primaryAddress({ addresses: [{ label: 'secondary', address: 'B' }] }), 'B');
  assert.equal(primaryAddress({}), '');
  assert.equal(primaryAddress(null), '');
});
