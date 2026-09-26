process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/GymPilot';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const { baseFor, clean } = require('../../src/services/username');
const { themeFor, DEFAULT_THEME_KEY, THEMES } = require('../../src/config/themes');
const { absoluteAsset } = require('../../src/services/branding');

test('a username reads like the member, not like a machine', () => {
  assert.equal(baseFor({ firstName: 'Sara', lastName: 'Malik', email: 'sara.malik@example.com' }), 'saramalik');
  assert.equal(baseFor({ firstName: 'Ayesha', lastName: 'Khan', email: 'ayesha.khan@gympilot.test' }), 'ayeshakhan');
});

test('the email is the fallback when the name is not usable', () => {
  assert.equal(baseFor({ firstName: 'A', lastName: '', email: 'longer.name@example.com' }), 'longername');
  assert.equal(baseFor({ email: 'just.email@example.com' }), 'justemail');
});

test('punctuation, accents and spacing are dropped so it can be read aloud', () => {
  assert.equal(clean("O'Brien-Smith Jr."), 'obriensmithjr');
  assert.equal(clean('José Álvarez'), 'josealvarez');
  assert.equal(clean('  Sara  '), 'sara');
});

test('a very long name is cut so the whole username stays sayable', () => {
  const base = baseFor({ firstName: 'Bartholomew', lastName: 'Featherstonehaugh', email: 'b@example.com' });
  assert.equal(base.length, 14);
  assert.equal(base, 'bartholomewfea');
});

test('an account with nothing usable still gets a word, never bare digits', () => {
  assert.equal(baseFor({}), 'member');
  assert.equal(baseFor({ firstName: '!!', email: '' }), 'member');
});

test('every colour scheme carries the six tokens the app paints with', () => {
  assert.ok(THEMES.length >= 8);
  for (const theme of THEMES) {
    for (const token of ['accent', 'accentDark', 'accentSoft', 'onAccent', 'base', 'surface']) {
      assert.match(theme.tokens[token], /^#[0-9a-f]{6}$/i, `${theme.key}.${token}`);
    }
  }
});

test('an unknown or missing colour scheme falls back to the default', () => {
  assert.equal(themeFor('no-such-theme').key, DEFAULT_THEME_KEY);
  assert.equal(themeFor(undefined).key, DEFAULT_THEME_KEY);
  assert.equal(themeFor('royal-violet').tokens.accent, '#8b5cf6');
});

test('a gym logo the phone app can load', () => {
  // Uploaded logos are already absolute and are left exactly as they are.
  const blob = 'https://blob.example.com/logos/lift.png';
  assert.equal(absoluteAsset(blob, 'https://demogym.example', 'https://api.gympilot.app'), blob);

  // A relative path belongs to the gym's own website, not to the API, and the
  // first origin offered wins.
  assert.equal(absoluteAsset('/images/logo.png', 'https://demogym.example/', ''), 'https://demogym.example/images/logo.png');
  assert.equal(absoluteAsset('images/logo.png', '', 'https://demogym.example'), 'https://demogym.example/images/logo.png');

  // Nothing to resolve against, and nothing to resolve.
  assert.equal(absoluteAsset('/images/logo.png'), '/images/logo.png');
  assert.equal(absoluteAsset('', 'https://demogym.example'), '');
});
