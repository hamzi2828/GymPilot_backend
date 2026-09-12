// Settings secrets at rest: seal / open, and the model paths that use them.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'unit-test-settings-key';
delete process.env.DEFAULT_TENANT_SLUG;

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { seal, open, isSealed, secretString, PREFIX } = require('../../src/services/secretBox');
const { runWithTenant } = require('../../src/platform/tenantContext');

const gymA = { _id: '000000000000000000000001', slug: 'a', database: { name: 'gympilot_unit_a' } };
const gymB = { _id: '000000000000000000000002', slug: 'b', database: { name: 'gympilot_unit_b' } };

test('a secret seals to a self-describing token and opens back to itself', () => {
  const sealed = seal('sk_test_4eC39HqLyjWDarjtT1zdp7dc');
  assert.ok(sealed.startsWith(PREFIX));
  assert.equal(sealed.slice(PREFIX.length).split(':').length, 3);
  assert.ok(isSealed(sealed));
  assert.notEqual(sealed, 'sk_test_4eC39HqLyjWDarjtT1zdp7dc');
  assert.equal(open(sealed), 'sk_test_4eC39HqLyjWDarjtT1zdp7dc');
  // A fresh IV every time: two seals of one value never look alike.
  assert.notEqual(seal('same'), seal('same'));
});

test('values written before sealing existed pass straight through', () => {
  assert.equal(open('sk_live_plain_from_last_year'), 'sk_live_plain_from_last_year');
  assert.equal(open(''), '');
  assert.equal(open(null), null);
  assert.equal(open(undefined), undefined);
  assert.equal(isSealed('plain'), false);
});

test('sealing is idempotent and keeps "not set" as empty', () => {
  const once = seal('token');
  assert.equal(seal(once), once, 'a sealed value read back and re-saved is not sealed twice');
  assert.equal(seal(''), '');
  assert.equal(seal(null), null);
  assert.equal(seal(undefined), undefined);
});

test('a tampered or foreign token opens to "not set" rather than throwing', () => {
  const sealed = seal('whsec_abc');
  const parts = sealed.slice(PREFIX.length).split(':');
  const flipped = Buffer.from(parts[2], 'base64');
  flipped[0] ^= 0xff;
  const tampered = PREFIX + [parts[0], parts[1], flipped.toString('base64')].join(':');
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(open(tampered), '');
    assert.equal(open(PREFIX + 'not:enough'), '');
  } finally {
    console.error = quiet;
  }
});

test('each gym has its own key: one gym cannot open another gym\'s secret', async () => {
  const sealedByA = await runWithTenant(gymA, () => seal('gym-a-smtp-password'));
  await runWithTenant(gymA, () => assert.equal(open(sealedByA), 'gym-a-smtp-password'));
  const quiet = console.error;
  console.error = () => {};
  try {
    await runWithTenant(gymB, () => assert.equal(open(sealedByA), ''));
    assert.equal(open(sealedByA), '', 'nor can the un-scoped (legacy) key');
  } finally {
    console.error = quiet;
  }
});

test('a schema path built with secretString() stores ciphertext and reads plaintext', () => {
  const schema = new mongoose.Schema(
    { pass: secretString(), key: secretString({ trim: false }), nested: { token: secretString() } },
    { toObject: { getters: true, virtuals: false }, toJSON: { getters: true, virtuals: false } }
  );
  const Model = mongoose.model('SecretBoxProbe', schema);

  const doc = new Model({ pass: '  hunter2  ', key: ' raw ', nested: { token: 'tok' } });
  // What would be written to the database is sealed...
  assert.ok(isSealed(doc.get('pass', null, { getters: false })));
  assert.ok(isSealed(doc.get('nested.token', null, { getters: false })));
  // ...and every way of reading it opens it, with the trim having happened
  // before the seal on a trimmed field and not at all on an untrimmed one.
  assert.equal(doc.pass, 'hunter2');
  assert.equal(doc.key, ' raw ');
  assert.equal(doc.nested.token, 'tok');
  assert.equal(doc.toObject().pass, 'hunter2');
  assert.equal(JSON.parse(JSON.stringify(doc)).nested.token, 'tok');
  assert.equal(doc.toObject({ getters: true }).nested.token, 'tok');

  // A row written before sealing existed reads back unchanged, and a row
  // written after opens.
  const legacy = Model.hydrate({ _id: new mongoose.Types.ObjectId(), pass: 'plain-old-password', nested: { token: seal('sealed-token') } });
  assert.equal(legacy.pass, 'plain-old-password');
  assert.equal(legacy.nested.token, 'sealed-token');
  assert.equal(legacy.toObject().nested.token, 'sealed-token');

  // Writing a sealed value back (as a .lean() reader would) does not seal it
  // again: it opens to the same plaintext.
  const echoed = new Model({ pass: legacy.get('nested.token', null, { getters: false }) });
  assert.equal(echoed.pass, 'sealed-token');
});

test('the Settings model seals its secret paths and getSettings-style reads open them', async () => {
  const Settings = require('../../src/models/settings');
  await runWithTenant(gymA, () => {
    assert.deepEqual(Settings.SECRET_PATHS.slice(0, 3), ['stripe.secretKey', 'stripe.webhookSecret', 'smtp.pass']);

    const doc = new Settings({
      siteName: 'Unit Gym',
      stripe: { publishableKey: 'pk_test_1', secretKey: 'sk_test_1', webhookSecret: 'whsec_1', enabled: true },
      smtp: { host: 'smtp.example.com', user: 'mailer', pass: 'p@ss word' },
      messaging: { sms: { authToken: 'twilio-token' }, whatsapp: { accessToken: 'meta-token' }, push: { vapidPrivateKey: 'vapid-private' } }
    });

    for (const path of Settings.SECRET_PATHS) {
      const raw = doc.get(path, null, { getters: false });
      if (raw) assert.ok(isSealed(raw), `${path} is sealed at rest`);
    }
    // The publishable key and everything else stay as they are.
    assert.equal(doc.get('stripe.publishableKey', null, { getters: false }), 'pk_test_1');

    // What every reader gets: the plaintext, whether through the document,
    // toObject() (sanitizeSettings) or the plain object getSettings() builds.
    assert.equal(doc.stripe.secretKey, 'sk_test_1');
    assert.equal(doc.smtp.pass, 'p@ss word');
    const plain = doc.toObject({ getters: true, virtuals: false, minimize: false });
    assert.equal(plain.stripe.webhookSecret, 'whsec_1');
    assert.equal(plain.messaging.sms.authToken, 'twilio-token');
    assert.equal(plain.messaging.whatsapp.accessToken, 'meta-token');
    assert.equal(plain.messaging.push.vapidPrivateKey, 'vapid-private');
    assert.equal(plain.siteName, 'Unit Gym');
    assert.equal(doc.toObject().smtp.pass, 'p@ss word', 'schema-level toObject applies the getters');

    // A settings row from before sealing reads exactly as before.
    const legacy = Settings.hydrate({ _id: new mongoose.Types.ObjectId(), isActive: true, stripe: { secretKey: 'sk_live_legacy' }, smtp: { pass: 'old' } });
    assert.equal(legacy.stripe.secretKey, 'sk_live_legacy');
    assert.equal(legacy.toObject().smtp.pass, 'old');
  });
});
