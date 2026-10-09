const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, normaliseCurrency, resolveCurrency, toMinorUnits, fromMinorUnits } = require('../../src/helper/money');

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

test('toMinorUnits charges three-decimal currencies in thousandths, not a tenth of the price', () => {
  // A dinar is 1000 fils: 12.5 KWD is 12500, where x100 sent 1250 (1.25 KWD).
  for (const code of ['BHD', 'JOD', 'KWD', 'OMR', 'TND', 'kwd']) assert.equal(toMinorUnits(12.5, code), 12500, code);
  assert.equal(toMinorUnits(40, 'bhd'), 40000);
  assert.equal(toMinorUnits(0.1 + 0.2, 'omr'), 300);
  // Stripe refuses a three-decimal amount that does not end in 0, so the
  // amount is rounded to the hundredth first.
  assert.equal(toMinorUnits(5.124, 'kwd'), 5120);
  assert.equal(toMinorUnits(5.126, 'kwd'), 5130);
  assert.equal(toMinorUnits(0.01, 'jod') % 10, 0);
  // The others are as they were.
  assert.equal(toMinorUnits(12.5, 'aed'), 1250);
  assert.equal(toMinorUnits(12.5, 'pkr'), 1250);
});

test('fromMinorUnits is the way back for every kind of currency', () => {
  assert.equal(fromMinorUnits(1234, 'gbp'), 12.34);
  assert.equal(fromMinorUnits(1500, 'jpy'), 1500);
  assert.equal(fromMinorUnits(12500, 'kwd'), 12.5);
  assert.equal(fromMinorUnits(40000, 'BHD'), 40);
  // What comes back is kept to two decimals, like every stored amount.
  assert.equal(fromMinorUnits(5124, 'kwd'), 5.12);
  // No currency reads as the fallback, a two-decimal one; nothing reads as nothing.
  assert.equal(fromMinorUnits(5000, undefined), 50);
  assert.equal(fromMinorUnits(undefined, 'gbp'), 0);
  // There and back again.
  for (const [amount, code] of [[49.99, 'usd'], [1500, 'jpy'], [12.75, 'kwd'], [0.5, 'tnd'], [2500, 'pkr']]) {
    assert.equal(fromMinorUnits(toMinorUnits(amount, code), code), amount, `${amount} ${code}`);
  }
});

test('parseAmount keeps two decimals, and a typed half rounds up every time', () => {
  // A third decimal is rounded away for every currency: a card can only be
  // charged a three-decimal currency to the hundredth (toMinorUnits).
  assert.equal(parseAmount('12.500'), 12.5);
  assert.equal(parseAmount('12.345'), 12.35);
  assert.equal(parseAmount('2.675'), 2.68);
  assert.equal(parseAmount('1.005'), 1.01);
  assert.equal(parseAmount('19.999'), 20);
  assert.equal(parseAmount('12.344'), 12.34);
  // Two decimals typed are two decimals kept.
  for (const typed of ['0.57', '49.99', '1299.99', '0.07', '1.15', '8.35']) assert.equal(parseAmount(typed), Number(typed), typed);
});
