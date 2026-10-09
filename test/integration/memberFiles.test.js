// A member's uploaded files, against a real MongoDB and the local-disk
// store: replacing a photo and removing a document delete the file they no
// longer point at, and deleting the account deletes what is left -- its
// photo and its documents -- while another gym's files stay where they are.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

const SLUG = `member-files-gym-${process.pid}`;
const OTHER = `member-files-other-${process.pid}`;

let gym;
let User;
let profiles;
let releaseAccount;
let UPLOADS_DIR;
let admin;
let member;

const test = h.suite(async () => {
  User = h.src('models/user');
  profiles = h.src('controller/memberProfileController');
  ({ releaseAccount } = h.src('controller/userController'));
  ({ UPLOADS_DIR } = h.src('helper/upload'));

  gym = await h.createGym(SLUG);
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User);
    await h.src('services/roleService').ensureDefaultRoles();
    const password = await bcrypt.hash('files-pass-1', 4);
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@files.test', role: 'admin', password, employment: { isStaff: true } });
    member = await User.create({ firstName: 'Moiz', lastName: 'Member', email: 'moiz@files.test', role: 'user', password });
  });
});

require('node:test').after(() => {
  for (const slug of [SLUG, OTHER]) fs.rmSync(path.join(UPLOADS_DIR, slug), { recursive: true, force: true });
});

const as = (actor) => ({ user: { id: String(actor._id), role: actor.role, email: actor.email }, roleSlug: actor.role });
const onDisk = (url) => fs.existsSync(path.join(UPLOADS_DIR, url.slice('/uploads/'.length)));

// What multer's disk storage hands a controller: the file already written
// under the gym's folder, and its name relative to the uploads directory.
function stored(name, mimetype, slug = SLUG) {
  fs.mkdirSync(path.join(UPLOADS_DIR, slug), { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, slug, name), 'x');
  return { filename: `${slug}/${name}`, originalname: name, mimetype, size: 1 };
}

const call = (handler, req) => h.inGym(gym, () => h.call(handler, { ...as(admin), ...req }));

test('a new photo replaces the old one on disk as well as on the account', async () => {
  const id = String(member._id);
  const first = await call(profiles.setPhoto, { params: { id }, file: stored('photo-1.png', 'image/png') });
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  const firstUrl = first.body.data.avatarUrl;
  assert.equal(onDisk(firstUrl), true);

  const second = await call(profiles.setPhoto, { params: { id }, file: stored('photo-2.png', 'image/png') });
  assert.equal(onDisk(firstUrl), false, 'the replaced photo is gone');
  assert.equal(onDisk(second.body.data.avatarUrl), true);
});

test('removing a document deletes its file', async () => {
  const id = String(member._id);
  const added = await call(profiles.addDocument, { params: { id }, body: { name: 'ID card' }, file: stored('id-card.pdf', 'application/pdf') });
  assert.equal(added.statusCode, 201, JSON.stringify(added.body));
  assert.equal(onDisk(added.body.data.url), true);

  const removed = await call(profiles.removeDocument, { params: { id, docId: added.body.data.id } });
  assert.equal(removed.statusCode, 200);
  assert.equal(onDisk(added.body.data.url), false);
});

test('deleting an account deletes its photo and documents, and nothing of another gym', async () => {
  const id = String(member._id);
  const letter = await call(profiles.addDocument, { params: { id }, file: stored('medical-letter.pdf', 'application/pdf') });
  const scan = await call(profiles.addDocument, { params: { id }, file: stored('passport.png', 'image/png') });
  const foreign = `/uploads/${stored('theirs.pdf', 'application/pdf', OTHER).filename}`;

  const account = await h.inGym(gym, async () => {
    // A document that somehow points into another gym's folder is not ours
    // to delete.
    await User.updateOne({ _id: id }, { $push: { documents: { name: 'Stray', url: foreign } } });
    return User.findById(id).select('+documents').lean();
  });
  const photo = account.avatarUrl;
  assert.equal(account.documents.length, 3);
  assert.equal(onDisk(photo), true);

  await h.inGym(gym, async () => {
    await User.deleteOne({ _id: id });
    await releaseAccount(account);
  });

  assert.equal(onDisk(photo), false, 'the photo went with the account');
  assert.equal(onDisk(letter.body.data.url), false, 'and the medical letter');
  assert.equal(onDisk(scan.body.data.url), false, 'and the ID scan');
  assert.equal(onDisk(foreign), true, "another gym's file is untouched");

  // An account loaded without its documents (they are select: false) still
  // releases cleanly.
  await h.inGym(gym, () => releaseAccount({ _id: id, role: 'user' }));
});
