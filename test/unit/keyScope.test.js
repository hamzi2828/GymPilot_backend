// Which key a gym's secrets and fingerprints are sealed with must not hang on
// DEFAULT_TENANT_SLUG: a multi-gym deployment unsets that, and the gym that
// predates per-gym keys must keep opening what it already stored.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'unit-test-settings-key';
process.env.FINGERPRINT_ENCRYPTION_KEY = process.env.FINGERPRINT_ENCRYPTION_KEY || 'unit-test-fingerprint-key';
delete process.env.DEFAULT_TENANT_SLUG;
delete process.env.LEGACY_KEY_TENANT_SLUG;

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { seal, open, usesLegacyKey } = require('../../src/services/secretBox');
const Fingerprint = require('../../src/attendance/models/fingerprintModel');
const { runWithTenant } = require('../../src/platform/tenantContext');

const demoGym = { _id: '0000000000000000000000a1', slug: 'demo', database: { name: 'gympilot_unit_demo' } };
const other = { _id: '0000000000000000000000a2', slug: 'ironworks', database: { name: 'gympilot_unit_ironworks' } };

// Sets (or, with undefined, removes) env vars for the length of fn.
async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function quietly(fn) {
  const error = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
  }
}

test('the legacy gym is named by LEGACY_KEY_TENANT_SLUG, falling back to DEFAULT_TENANT_SLUG', async () => {
  assert.equal(usesLegacyKey(null), true, 'outside any gym');

  await withEnv({ DEFAULT_TENANT_SLUG: 'demo', LEGACY_KEY_TENANT_SLUG: undefined }, () => {
    assert.equal(usesLegacyKey(demoGym), true, 'today: the default gym');
    assert.equal(usesLegacyKey(other), false);
  });

  await withEnv({ DEFAULT_TENANT_SLUG: undefined, LEGACY_KEY_TENANT_SLUG: 'demo' }, () => {
    assert.equal(usesLegacyKey(demoGym), true, 'default unset, legacy slug kept');
    assert.equal(usesLegacyKey(other), false);
  });

  await withEnv({ DEFAULT_TENANT_SLUG: 'ironworks', LEGACY_KEY_TENANT_SLUG: 'demo' }, () => {
    assert.equal(usesLegacyKey(demoGym), true, 'the legacy slug wins over the default');
    assert.equal(usesLegacyKey(other), false);
  });

  await withEnv({ DEFAULT_TENANT_SLUG: undefined, LEGACY_KEY_TENANT_SLUG: undefined }, () => {
    assert.equal(usesLegacyKey(demoGym), false, 'neither set: every gym has its own key');
  });
});

test('settings secrets still open after DEFAULT_TENANT_SLUG is removed, when LEGACY_KEY_TENANT_SLUG is set', async () => {
  let sealedByDemo;
  let sealedByOther;
  await withEnv({ DEFAULT_TENANT_SLUG: 'demo', LEGACY_KEY_TENANT_SLUG: undefined }, async () => {
    sealedByDemo = await runWithTenant(demoGym, () => seal('sk_live_demo'));
    sealedByOther = await runWithTenant(other, () => seal('sk_live_ironworks'));
  });
  // The scope is the original, un-suffixed one: what a pre-platform process
  // (no gym in context) sealed.
  const sealedBeforePlatform = seal('smtp-password-from-2025');

  await withEnv({ DEFAULT_TENANT_SLUG: undefined, LEGACY_KEY_TENANT_SLUG: 'demo' }, async () => {
    await runWithTenant(demoGym, () => {
      assert.equal(open(sealedByDemo), 'sk_live_demo');
      assert.equal(open(sealedBeforePlatform), 'smtp-password-from-2025');
    });
    await runWithTenant(other, () => assert.equal(open(sealedByOther), 'sk_live_ironworks'));
  });

  // What happened before this setting existed: unsetting the default re-keyed
  // the gym and its secrets silently became "not set".
  await withEnv({ DEFAULT_TENANT_SLUG: undefined, LEGACY_KEY_TENANT_SLUG: undefined }, () =>
    quietly(() => runWithTenant(demoGym, () => assert.equal(open(sealedByDemo), '')))
  );
});

test('fingerprint templates follow the same rule', async () => {
  let stored;
  await withEnv({ DEFAULT_TENANT_SLUG: 'demo', LEGACY_KEY_TENANT_SLUG: undefined }, async () => {
    stored = await runWithTenant(demoGym, () => Fingerprint.encryptTemplate('UEVSU09O'));
  });

  await withEnv({ DEFAULT_TENANT_SLUG: undefined, LEGACY_KEY_TENANT_SLUG: 'demo' }, async () => {
    await runWithTenant(demoGym, () => assert.equal(Fingerprint.decryptTemplate(stored), 'UEVSU09O'));
    await runWithTenant(other, () => assert.equal(Fingerprint.decryptTemplate(stored), null, 'another gym cannot read it'));
  });

  await withEnv({ DEFAULT_TENANT_SLUG: undefined, LEGACY_KEY_TENANT_SLUG: undefined }, async () => {
    await runWithTenant(demoGym, () => assert.equal(Fingerprint.decryptTemplate(stored), null));
  });
});
