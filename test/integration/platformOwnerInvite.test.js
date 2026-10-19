// "Resend owner invite" from the platform panel, against a real MongoDB:
// when the set-password email cannot be sent the answer carries the reason
// (`data.inviteError`), not only "could not be sent"; when it goes, null.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gyms;
let SuperAdmin;
let gym;
let admin;

const test = h.suite(async () => {
  gyms = h.src('platform/controllers/gymsController');
  SuperAdmin = h.src('platform/models/superAdminModel');
  admin = (await SuperAdmin.create({ name: 'Owner', email: 'owner@invite-platform.test', password: 'not-used-here' })).toObject();
  gym = await h.createGym('invite-gym', { name: 'Invite Gym' });
});

const resend = (email) => h.call(gyms.resetOwnerPassword, { superAdmin: admin, params: { id: String(gym._id) }, body: { email }, socket: {} });

test('an invite that cannot be emailed says why', async () => {
  h.setEmailFailure('Invalid login: 535 Authentication failed');
  try {
    const res = await resend('boss@invite-gym.test');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.inviteSent, false);
    assert.equal(res.body.data.inviteError, 'Invalid login: 535 Authentication failed');
    assert.deepEqual(res.body.warnings, ['Owner email could not be sent']);
  } finally {
    h.setEmailFailure(null);
  }
});

test('an invite that goes has no error', async () => {
  const before = h.calls.emails.length;
  const res = await resend('boss@invite-gym.test');
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.inviteSent, true);
  assert.equal(res.body.data.inviteError, null);
  assert.deepEqual(res.body.warnings, []);
  assert.equal(h.calls.emails.length, before + 1);
  assert.equal(h.calls.emails[h.calls.emails.length - 1].to, 'boss@invite-gym.test');
});
