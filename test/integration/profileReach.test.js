// Who may change whose profile, against a real MongoDB: `users: manage` opens
// the profile actions (details, photo, documents, the agreement), but a
// receptionist holding it cannot use them on an administrator or on a manager
// whose role reaches further than theirs -- only on members, on accounts
// level with their own, and on themselves.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

const SLUG = `profile-reach-gym-${process.pid}`;

let gym;
let User;
let profiles;
let UPLOADS_DIR;
const people = {};

const test = h.suite(async () => {
  User = h.src('models/user');
  profiles = h.src('controller/memberProfileController');
  ({ UPLOADS_DIR } = h.src('helper/upload'));
  const Role = h.src('models/roleModel');
  const roles = h.src('services/roleService');

  gym = await h.createGym(SLUG);
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User);
    await roles.ensureDefaultRoles();
    // Whatever the shipped receptionist role holds, this one manages users.
    await Role.updateOne({ slug: 'receptionist' }, { $set: { 'permissions.users': 'manage' } });
    roles.invalidate();
    const password = await bcrypt.hash('reach-pass-1', 4);
    const make = (firstName, role) => User.create({ firstName, lastName: 'Reach', email: `${firstName.toLowerCase()}@reach.test`, role, password, employment: { isStaff: role !== 'user' } });
    people.admin = await make('Ada', 'admin');
    people.manager = await make('Mona', 'manager');
    people.desk = await make('Rida', 'receptionist');
    people.colleague = await make('Rafi', 'receptionist');
    people.member = await make('Moiz', 'user');
  });
});

require('node:test').after(() => {
  fs.rmSync(path.join(UPLOADS_DIR, SLUG), { recursive: true, force: true });
});

const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });
const call = (actor, handler, req) => h.inGym(gym, () => h.call(handler, { ...as(actor), ...req }));

function upload(name, mimetype) {
  fs.mkdirSync(path.join(UPLOADS_DIR, SLUG), { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, SLUG, name), 'x');
  return { filename: `${SLUG}/${name}`, originalname: name, mimetype, size: 1 };
}

// Every profile action, as one request on `target`.
function actions(target, docId) {
  const id = String(target._id);
  return [
    ['details', profiles.updateProfile, { params: { id }, body: { phone: '0300 1112223', staffNotes: 'changed' } }],
    ['photo', profiles.setPhoto, { params: { id }, file: upload(`photo-${id}.png`, 'image/png') }],
    ['add document', profiles.addDocument, { params: { id }, file: upload(`doc-${id}.pdf`, 'application/pdf') }],
    ['remove document', profiles.removeDocument, { params: { id, docId } }],
    ['agreement', profiles.recordWaiver, { params: { id }, body: { signature: 'Somebody Else' } }]
  ];
}

test('a receptionist cannot change an administrator\'s or a manager\'s profile', async () => {
  for (const [target, sentence] of [
    [people.admin, /Only an administrator can change an administrator's profile/],
    [people.manager, /more access than yours \(.+\), so ask an administrator to change its profile/]
  ]) {
    const doc = await h.inGym(gym, async () => {
      await User.updateOne({ _id: target._id }, { $set: { documents: [{ name: 'Contract', url: `/uploads/${SLUG}/contract-${target._id}.pdf` }] } });
      return (await User.findById(target._id).select('+documents').lean()).documents[0];
    });
    for (const [name, handler, req] of actions(target, String(doc._id))) {
      const res = await call(people.desk, handler, req);
      assert.equal(res.statusCode, 403, `${name}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.message, sentence);
    }
    const after = await h.inGym(gym, () => User.findById(target._id).select('+documents +staffNotes').lean());
    assert.equal(after.phone || null, null);
    assert.equal(after.avatarUrl || null, null);
    assert.equal(after.staffNotes || '', '');
    assert.equal(after.documents.length, 1);
    assert.equal((after.waiver && after.waiver.signedAt) || null, null);
  }
});

test('the same receptionist still looks after members, colleagues and their own record', async () => {
  for (const target of [people.member, people.colleague, people.desk]) {
    const added = await call(people.desk, profiles.addDocument, { params: { id: String(target._id) }, file: upload(`first-${target._id}.pdf`, 'application/pdf') });
    assert.equal(added.statusCode, 201, JSON.stringify(added.body));
    for (const [name, handler, req] of actions(target, added.body.data.id)) {
      const res = await call(people.desk, handler, req);
      assert.ok(res.statusCode < 300, `${name} on ${target.firstName}: ${JSON.stringify(res.body)}`);
    }
  }
});

test('an administrator changes anyone\'s profile, another administrator\'s included', async () => {
  const other = await h.inGym(gym, async () => User.create({ firstName: 'Omar', lastName: 'Reach', email: 'omar@reach.test', role: 'admin', password: await bcrypt.hash('reach-pass-1', 4), employment: { isStaff: true } }));
  for (const target of [other, people.manager]) {
    const res = await call(people.admin, profiles.updateProfile, { params: { id: String(target._id) }, body: { phone: '0300 9998887' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  }
});

test('a request with no account behind it reaches members only', async () => {
  const refused = await h.inGym(gym, () => h.call(profiles.updateProfile, { params: { id: String(people.admin._id) }, body: { phone: '1' } }));
  assert.equal(refused.statusCode, 403);
});
