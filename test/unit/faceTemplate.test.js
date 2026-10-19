// Face templates at rest (models/faceTemplateModel.js), without a database:
// the vectors come back exactly as they went in, sealed under a key of this
// gym's own -- another gym's key, the fingerprint store's key, or a tampered
// row reads as nothing -- and only a well-formed SFace template is taken.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithTenant } = require('../../src/platform/tenantContext');
const FaceTemplate = require('../../src/attendance/models/faceTemplateModel');
const Fingerprint = require('../../src/attendance/models/fingerprintModel');

const gymA = { _id: '00000000000000000000fa01', slug: 'unit-faces-a', database: { name: 'gympilot_unit_faces_a' }, domains: [] };
const gymB = { _id: '00000000000000000000fa02', slug: 'unit-faces-b', database: { name: 'gympilot_unit_faces_b' }, domains: [] };

// A unit vector of 128, as the desk sends them, with a little of `seed` in it.
function vector(seed) {
  const raw = Array.from({ length: 128 }, (_, i) => Math.sin(seed * 31 + i * 0.7));
  const norm = Math.sqrt(raw.reduce((sum, n) => sum + n * n, 0));
  return raw.map((n) => n / norm);
}

test('the vectors come back exactly as they went in, and the stored form shows none of them', async () => {
  const vectors = [vector(1), vector(2), vector(3)];
  await runWithTenant(gymA, () => {
    const sealed = FaceTemplate.encryptEmbeddings(vectors);
    assert.equal(sealed.split(':').length, 3, 'iv:tag:payload');
    assert.ok(!sealed.includes(String(vectors[0][0]).slice(0, 8)), 'no number in the clear');
    assert.deepEqual(FaceTemplate.decryptEmbeddings(sealed), vectors);
    assert.notEqual(FaceTemplate.encryptEmbeddings(vectors), sealed, 'a fresh IV every time');
  });
});

test("each gym's faces open only with that gym's key", async () => {
  const sealed = await runWithTenant(gymA, () => FaceTemplate.encryptEmbeddings([vector(4)]));
  await runWithTenant(gymB, () => {
    assert.equal(FaceTemplate.decryptEmbeddings(sealed), null, 'another gym cannot read it');
  });
  await runWithTenant(gymA, () => {
    assert.deepEqual(FaceTemplate.decryptEmbeddings(sealed), [vector(4)]);
  });
});

test('a face key is not the fingerprint key, and a tampered or broken row reads as nothing', async () => {
  await runWithTenant(gymA, () => {
    const finger = Fingerprint.encryptTemplate(JSON.stringify([vector(5)]));
    assert.equal(FaceTemplate.decryptEmbeddings(finger), null, 'sealed by the fingerprint store');

    const sealed = FaceTemplate.encryptEmbeddings([vector(6)]);
    const [iv, tag, payload] = sealed.split(':');
    const flipped = payload.slice(0, -2) + (payload.endsWith('AA') ? 'BB' : 'AA');
    assert.equal(FaceTemplate.decryptEmbeddings([iv, tag, flipped].join(':')), null);
    for (const junk of ['', null, undefined, 'a:b', 'not:base:64!', 42]) {
      assert.equal(FaceTemplate.decryptEmbeddings(junk), null, String(junk));
    }
  });
});

test('nothing is sealed outside a gym', async () => {
  // The function itself, carried out of the gym it was looked up in.
  const encrypt = await runWithTenant(gymA, () => FaceTemplate.schema.statics.encryptEmbeddings);
  assert.throws(() => encrypt([vector(7)]), /per gym/);
});

test('only 1 to 10 vectors of 128 finite numbers are a template', async () => {
  await runWithTenant(gymA, () => {
    const read = FaceTemplate.readEmbeddings;
    assert.deepEqual(read([vector(1)]), [vector(1)]);
    assert.equal(read(Array.from({ length: 10 }, (_, i) => vector(i))).length, 10);

    const withAt = (index, value) => {
      const v = vector(8);
      v[index] = value;
      return [v];
    };
    for (const [label, bad] of [
      ['nothing', undefined],
      ['no vectors', []],
      ['eleven vectors', Array.from({ length: 11 }, (_, i) => vector(i))],
      ['127 numbers', [vector(1).slice(1)]],
      ['129 numbers', [[...vector(1), 0]]],
      ['a flat list', vector(1)],
      ['a string', 'vector'],
      ['a number as text', withAt(5, '0.25')],
      ['null (what JSON makes of NaN)', withAt(5, null)],
      ['NaN', withAt(5, NaN)],
      ['Infinity (what JSON makes of 1e400)', withAt(5, Infinity)],
      ['a nested list', withAt(5, [0.1])],
      ['one good vector and one short', [vector(1), vector(2).slice(0, 64)]]
    ]) {
      assert.equal(read(bad), null, label);
    }
  });
});

test('one row per person, the vectors kept out of every ordinary read, in a prefixed collection', async () => {
  const schema = await runWithTenant(gymA, () => FaceTemplate.schema);
  assert.equal(schema.path('embeddings').options.select, false);
  assert.equal(schema.options.collection, 'gym_face_templates');
  const unique = schema.indexes().find(([fields, options]) => options && options.unique);
  assert.deepEqual(unique[0], { personType: 1, personId: 1 });
  assert.equal(schema.statics.FACE_MODEL, 'sface-2021dec');
});
