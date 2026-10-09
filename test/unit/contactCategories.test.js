// What a contact-form enquiry can be filed under: the things somebody asks a
// gym about, with the old shop categories kept valid so the enquiries already
// stored under them still load and save.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const Contact = require('../../src/models/contactModel');

const gym = { _id: '0000000000000000000000c7', slug: 'unit-gym-contact', database: { name: 'gympilot_unit_gym_contact' }, locale: { timezone: 'UTC' } };

const enquiry = (category) =>
  new Contact({ fullName: 'Ann Asker', emailAddress: 'ann@contact-form.org', subject: 'A question', message: 'Hello, I have a question.', ...(category === undefined ? {} : { category }) });

test('an enquiry is filed under what gyms are asked about, and the old categories still hold', async () => {
  await runWithTenant(gym, () => {
    for (const category of ['general', 'membership', 'classes', 'personal-training', 'billing', 'other']) {
      assert.equal(enquiry(category).validateSync(), undefined, category);
    }
    // Rows from before: still valid, so opening and updating one does not fail.
    for (const category of ['support', 'returns', 'wholesale', 'technical', 'feedback']) {
      assert.equal(enquiry(category).validateSync(), undefined, category);
    }
    assert.equal(enquiry().category, 'general');
    const refused = enquiry('refunds-please').validateSync();
    assert.ok(refused && refused.errors.category, 'anything else is refused');
  });
});
