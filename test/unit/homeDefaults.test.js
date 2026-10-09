// What a new gym's homepage says before its owner has written a word: copy
// that is true of any gym. No member counts, opening hours or claims about
// staff, and where only a figure would do, the figure is left out.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithTenant } = require('../../src/platform/tenantContext');
const HomeSection = require('../../src/models/homeSectionModel');

const gym = { _id: '000000000000000000000007', slug: 'unit-gym-home', database: { name: 'gympilot_unit_gym_home' }, domains: [], locale: { timezone: 'UTC' } };
const defaults = () => runWithTenant(gym, async () => HomeSection.DEFAULT_SECTIONS);

// Every sentence a visitor would read. Links, image addresses and the stock
// gallery (pictures, not statements) are not copy.
function copy(section) {
  const out = [];
  const walk = (value, key) => {
    if (['ctaLink', 'image', 'src', 'url', 'poster'].includes(key)) return;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  walk(section.content, '');
  return out;
}

test('the default copy makes no claim a gym did not make itself', async () => {
  const claims = /\d|24\/7|certified|insured|qualified|award|the best|guarantee|at all times|every (coach|class|review|month|week)|sunrise|open \d|open seven|capped|our coaches/i;
  for (const section of await defaults()) {
    for (const sentence of copy(section)) {
      assert.doesNotMatch(sentence, claims, `${section.key}: "${sentence}"`);
    }
  }
});

test('figures nobody supplied are left out, not invented', async () => {
  const byKey = Object.fromEntries((await defaults()).map((section) => [section.key, section]));

  // The stats band is nothing but figures: hidden and empty until the gym
  // enters its own.
  assert.equal(byKey.stats.enabled, false);
  assert.deepEqual(byKey.stats.content, { items: [] });

  // The about section's percentage bars likewise.
  assert.deepEqual(byKey.about.content.progress, []);
});

test('the sections keep the shape the website and the editor read', async () => {
  const sections = await defaults();
  assert.deepEqual(sections.map((section) => section.key), await runWithTenant(gym, async () => HomeSection.SECTION_KEYS));

  const byKey = Object.fromEntries(sections.map((section) => [section.key, section]));
  assert.deepEqual(Object.keys(byKey.about.content), [
    'badge', 'heading', 'description', 'bullets', 'ctaText', 'ctaLink', 'image', 'secondHeading', 'secondDescription', 'progress'
  ]);
  assert.equal(byKey.about.content.bullets.length, 3);

  // Everything a visitor reads is still filled in: an empty heading would be
  // replaced by whatever the website falls back to.
  for (const key of ['about', 'classes', 'videos', 'trainers', 'testimonials', 'contact']) {
    for (const field of ['badge', 'heading', 'description']) {
      assert.ok(String(byKey[key].content[field] || '').trim(), `${key}.${field}`);
    }
  }

  // Only the two sections with nothing of the gym's own to show start hidden.
  assert.deepEqual(sections.filter((section) => section.enabled === false).map((section) => section.key), ['stats', 'videos']);
});
