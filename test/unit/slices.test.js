process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const { toCsv } = require('../../src/services/csv');
const { normalizePhone } = require('../../src/services/messaging');
const { fill, bodyToHtml, isEvent, EVENTS } = require('../../src/services/templateService');
const { normalizeBooking, normalizePt, DEFAULTS } = require('../../src/gymfolio/services/bookingRules');
const { dnsAdvice } = require('../../src/platform/vercelDomains');
const { daysInside } = require('../../src/services/payrollService');

test('CSV quotes, escapes and neutralises spreadsheet formulas', () => {
  const csv = toCsv(
    [{ key: 'name', label: 'Name' }, { key: 'note', label: 'Note' }],
    [{ name: 'Ann, "The Rock"', note: '=HYPERLINK("http://x")' }, { name: 'Bob', note: 'plain' }]
  );
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '﻿Name,Note');
  assert.equal(lines[1], '"Ann, ""The Rock""","\'=HYPERLINK(""http://x"")"');
  assert.equal(lines[2], 'Bob,plain');
});

test('phone numbers come out E.164-ish with the gym default code', () => {
  assert.equal(normalizePhone('+92 300 1234567'), '+923001234567');
  assert.equal(normalizePhone('0092 300 1234567'), '+923001234567');
  assert.equal(normalizePhone('0300-1234567', '+92'), '+923001234567');
  assert.equal(normalizePhone('whatsapp:+14155551234'), '+14155551234');
  assert.equal(normalizePhone('', '+92'), '');
});

test('placeholders fill and bodies become safe HTML', () => {
  assert.equal(fill('Hi {{firstName}}, {{missing}}!', { firstName: 'Ann' }, false), 'Hi Ann, !');
  assert.equal(fill('{{name}}', { name: '<b>' }, true), '&lt;b&gt;');
  const html = bodyToHtml('Hello {{firstName}}\n\nSee https://gym.test/x <script>alert(1)</script>', { firstName: 'Ann' });
  assert.match(html, /<p[^>]*>Hello Ann<\/p>/);
  assert.match(html, /<a href="https:\/\/gym.test\/x"/);
  assert.doesNotMatch(html, /<script/);
  assert.ok(isEvent('booking_confirmed'));
  assert.ok(!isEvent('nope'));
  assert.ok(EVENTS.every((e) => e.key && e.text));
});

test('booking and PT rules default to the old behaviour and clamp input', () => {
  assert.deepEqual(normalizeBooking({}), DEFAULTS);
  const rules = normalizeBooking({ horizonDays: 900, cutoffMinutes: -5, cancelHours: '24', requireActiveMembership: 'yes', noShowStrikes: 3 });
  assert.equal(rules.horizonDays, 365);
  assert.equal(rules.cutoffMinutes, DEFAULTS.cutoffMinutes);
  assert.equal(rules.cancelHours, 24);
  assert.equal(rules.requireActiveMembership, false);
  assert.equal(rules.noShowStrikes, 3);
  const pt = normalizePt({ slotMinutes: 5, defaultCommissionPercent: 150 });
  assert.equal(pt.slotMinutes, 60);
  assert.equal(pt.defaultCommissionPercent, 100);
});

test('DNS advice distinguishes apex from subdomain', () => {
  assert.equal(dnsAdvice('ironworks.com').type, 'A');
  assert.equal(dnsAdvice('www.ironworks.com').type, 'CNAME');
  assert.equal(dnsAdvice('www.ironworks.com').name, 'www');
});

test('unpaid leave days are clipped to the pay period', () => {
  assert.equal(daysInside('2026-09-01', '2026-09-03', '2026-09-01', '2026-09-30'), 3);
  assert.equal(daysInside('2026-08-30', '2026-09-02', '2026-09-01', '2026-09-30'), 2);
  assert.equal(daysInside('2026-10-01', '2026-10-02', '2026-09-01', '2026-09-30'), 0);
});
