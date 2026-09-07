const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, normaliseCurrency, resolveCurrency, toMinorUnits } = require('../../src/helper/money');

test('parseAmount reads the price strings gyms actually type', () => {
  assert.equal(parseAmount('40'), 40);
  assert.equal(parseAmount('Rs 2,500'), 2500);
  assert.equal(parseAmount('£49.99'), 49.99);
  assert.equal(parseAmount('1.234,50'), 1234.5);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('-10'), null);
  assert.equal(parseAmount(15), 15);
});

test('currencies normalise from symbols and codes', () => {
  assert.equal(normaliseCurrency('$'), 'USD');
  assert.equal(normaliseCurrency('pkr'), 'PKR');
  assert.equal(normaliseCurrency('AED'), 'AED');
  assert.equal(normaliseCurrency('nonsense'), null);
  assert.equal(resolveCurrency(null, 'gbp'), 'GBP');
  assert.equal(resolveCurrency(null, null), 'PKR');
});

test('toMinorUnits knows zero-decimal currencies', () => {
  assert.equal(toMinorUnits(12.34, 'usd'), 1234);
  assert.equal(toMinorUnits(1500, 'jpy'), 1500);
  assert.equal(toMinorUnits(0.1 + 0.2, 'gbp'), 30);
});
