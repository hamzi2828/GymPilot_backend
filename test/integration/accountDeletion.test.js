// Deleting an account hands everything stored for it to the clean-up,
// against a real MongoDB.
//
// A member's uploaded documents are `select: false`, so a query that does
// not ask for them does not load them -- and the clean-up that runs after
// an account is deleted (userController.releaseAccount) can only remove the
// stored files it is told about. Both ways an account is deleted load the
// photo and the documents first.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const h = require('./helpers/harness');

let gym;
let User;
let users;
let MemberDirectory;
let admin;

const test = h.suite(async () => {
  User = h.src('models/user');
  users = h.src('controller/userController');
  MemberDirectory = h.src('platform/models/memberDirectoryModel');

  gym = await h.createGym('deletion-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(User);
    await h.src('services/roleService').ensureDefaultRoles();
    admin = await User.create({ firstName: 'Ada', lastName: 'Admin', email: 'ada@deletion.test', role: 'admin', password: await bcrypt.hash('correct-horse-1', 4), employment: { isStaff: true } });
  });
});

const bearer = (account) => `Bearer ${jwt.sign({ id: String(account._id), email: account.email, role: account.role || 'user' }, process.env.JWT_SECRET)}`;
const DOCUMENTS = [
  { name: 'Passport', url: '/uploads/doc-passport.pdf', mimeType: 'application/pdf', size: 10 },
  { name: 'Medical note', url: 'https://blob.example.test/deletion-gym/doc-note.pdf', mimeType: 'application/pdf', size: 20 }
];

function member(firstName) {
  return h.inGym(gym, () =>
    User.create({ firstName, lastName: 'Leaving', email: `${firstName.toLowerCase()}@deletion.test`, password: 'x', avatarUrl: `/uploads/${firstName.toLowerCase()}.png`, documents: DOCUMENTS })
  );
}

/** Runs `fn` and resolves to the account the clean-up was handed. */
async function released(fn) {
  const real = MemberDirectory.withdraw;
  let seen = null;
  MemberDirectory.withdraw = async function withdraw(account) {
    seen = account;
    return real.call(this, account);
  };
  try {
    await fn();
  } finally {
    MemberDirectory.withdraw = real;
  }
  return seen;
}

function assertCarriesFiles(account, firstName) {
  assert.ok(account, 'the clean-up ran');
  assert.equal(account.avatarUrl, `/uploads/${firstName.toLowerCase()}.png`);
  assert.deepEqual((account.documents || []).map((doc) => doc.url), DOCUMENTS.map((doc) => doc.url));
}

test('a member deleting their own account hands over their photo and documents', async () => {
  const mia = await member('Mia');
  // An ordinary read does not carry the documents at all.
  assert.equal((await h.inGym(gym, () => User.findById(mia._id).lean())).documents, undefined);

  const account = await released(async () => {
    const res = await h.inGym(gym, () => h.call(users.deleteUser, { headers: { authorization: bearer(mia) } }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  });
  assertCarriesFiles(account, 'Mia');
  assert.equal(await h.inGym(gym, () => User.exists({ _id: mia._id })), null);
});

test('so does staff deleting it from the Users screen', async () => {
  const lou = await member('Lou');
  const account = await released(async () => {
    const res = await h.inGym(gym, () =>
      h.call(users.deleteUserById, { headers: { authorization: bearer(admin) }, user: { id: String(admin._id), role: 'admin' }, roleSlug: 'admin', params: { id: String(lou._id) } })
    );
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  });
  assertCarriesFiles(account, 'Lou');
  assert.equal(await h.inGym(gym, () => User.exists({ _id: lou._id })), null);
});
