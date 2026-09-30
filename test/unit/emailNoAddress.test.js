// A member may have no email address. Every send for one stops at the email
// service, answered like a failed send -- no crash, no mail server contacted.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { sendEmail } = require('../../src/services/emailService');

test('sending to no address is skipped without touching SMTP or settings', async () => {
  // Outside any tenant context: reaching Settings (or nodemailer) would
  // throw or hang, so a clean answer proves the send stopped at the guard.
  for (const to of [undefined, null, '', '   ']) {
    const result = await sendEmail(to, 'Subject', '<p>Hi</p>');
    assert.equal(result.success, false);
    assert.equal(result.skipped, 'no email address');
  }
});
