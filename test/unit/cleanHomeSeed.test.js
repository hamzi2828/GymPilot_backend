// scripts/cleanHomeSeed.js: taking the old made-up homepage text off gyms
// created before the defaults were rewritten. The decision tested here
// (scripts/lib/homeSeed.js) is the one rule the script has: a value is
// replaced only while it is still exactly what was seeded; anything a gym
// rewrote is left as it is.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithTenant } = require('../../src/platform/tenantContext');
const HomeSection = require('../../src/models/homeSectionModel');
const { OLD, OLD_BULLETS, OLD_PROGRESS, OLD_STATS, STOCK_PHOTOS, planSection, planGym } = require('../../scripts/lib/homeSeed');

const gym = { _id: '0000000000000000000000c8', slug: 'unit-gym-clean-home', database: { name: 'gympilot_unit_gym_clean_home' }, domains: [], locale: { timezone: 'UTC' } };
const clone = (value) => JSON.parse(JSON.stringify(value));

let DEFAULTS;
let byKey;
test.before(async () => {
  DEFAULTS = clone(await runWithTenant(gym, async () => HomeSection.DEFAULT_SECTIONS));
  byKey = Object.fromEntries(DEFAULTS.map((section) => [section.key, section.content]));
});

// A gym as it was created before the rewrite: today's shape, the old words.
function seededGym() {
  return DEFAULTS.map((section, index) => {
    const content = { ...clone(section.content), ...clone(OLD[section.key] || {}) };
    if (section.key === 'about') Object.assign(content, { bullets: [...OLD_BULLETS], progress: clone(OLD_PROGRESS) });
    if (section.key === 'stats') content.items = clone(OLD_STATS);
    return { _id: `section-${index}`, key: section.key, enabled: section.key !== 'videos', order: section.order, content };
  });
}

// The stored sections after a plan is applied ($set with dotted paths).
function applied(sections, plans) {
  const out = clone(sections);
  for (const plan of plans) {
    const section = out.find((row) => row._id === plan._id);
    for (const [path, value] of Object.entries(plan.set)) {
      if (path === 'enabled') section.enabled = value;
      else section.content[path.replace(/^content\./, '')] = clone(value);
    }
  }
  return out;
}

test('a gym still on the old seed loses every made-up claim and keeps the shape of its page', () => {
  const before = seededGym();
  const plans = planGym(before, DEFAULTS);
  const after = applied(before, plans);
  const read = (key) => after.find((section) => section.key === key);

  // Seeded text is today's default, field for field.
  for (const [key, fields] of Object.entries(OLD)) {
    for (const field of Object.keys(fields)) assert.equal(read(key).content[field], byKey[key][field], `${key}.${field}`);
  }
  assert.deepEqual(read('about').content.bullets, byKey.about.bullets);
  // Figures nobody supplied are gone, and the band with nothing in it is hidden.
  assert.deepEqual(read('about').content.progress, []);
  assert.deepEqual(read('stats').content.items, []);
  assert.equal(read('stats').enabled, false);
  // The stock photographs are gone, and the empty groups with them.
  assert.deepEqual(read('gallery').content.groups, []);
  assert.equal(read('gallery').enabled, true);

  // Nothing of the old seed is left anywhere, and nothing else was touched.
  const stored = JSON.stringify(after);
  for (const gone of ['24/7', 'Certified coaches', 'Active members', '1200', 'unsplash.com', 'certified, insured', 'The best fitness gym in town']) {
    assert.equal(stored.includes(gone), false, gone);
  }
  assert.equal(read('about').content.image, byKey.about.image);
  assert.equal(read('contact').content.heading, byKey.contact.heading);
  assert.deepEqual(read('blogs'), before.find((section) => section.key === 'blogs'));

  // The report names each value in plain words.
  const said = plans.flatMap((plan) => plan.changes.map((change) => `${plan.key}.${change.field}: ${change.was} -> ${change.now}`));
  assert.ok(said.includes('stats.items: 1200+ Active members -> (removed)'));
  assert.ok(said.includes(`about.bullets[0]: Open 7 days, with 24/7 access for members -> ${byKey.about.bullets[0]}`));
  assert.ok(said.some((line) => /^gallery\.groups "Strength": 4 stock photo\(s\) -> \(removed, and the group with them\)$/.test(line)));

  // Run again, there is nothing left to do.
  assert.deepEqual(planGym(after, DEFAULTS), []);
});

test('only what is still exactly the seed is replaced: anything the gym rewrote is left alone', () => {
  const before = seededGym();
  const about = before.find((section) => section.key === 'about').content;
  const stats = before.find((section) => section.key === 'stats');
  const gallery = before.find((section) => section.key === 'gallery').content;
  const trainers = before.find((section) => section.key === 'trainers').content;

  // The owner rewrote the heading, one bullet and one figure, kept a seeded
  // sentence with a word changed, and put a photo of their own in a group.
  about.heading = 'Iron Works, Sheffield';
  about.bullets[1] = 'Coaches on the floor from 6am to 10pm';
  about.secondDescription = `${OLD.about.secondDescription} Ask at the desk.`;
  about.progress[0].value = 70;
  stats.content.items[0] = { value: '430', suffix: '', label: 'Members' };
  stats.content.items[2].label = 'Classes a week';
  trainers.heading = OLD.trainers.heading.toUpperCase();
  gallery.groups[0].images.push({ src: 'https://blob.example/gym/floor.jpg', alt: 'Our floor' });
  gallery.groups[1].images[0].alt = 'Our treadmills';
  gallery.groups.push({ title: 'Studio', images: [{ src: 'https://blob.example/gym/studio.jpg', alt: 'Studio' }] });

  const after = applied(before, planGym(before, DEFAULTS));
  const read = (key) => after.find((section) => section.key === key);

  // Theirs, word for word.
  assert.equal(read('about').content.heading, 'Iron Works, Sheffield');
  assert.equal(read('about').content.secondDescription, `${OLD.about.secondDescription} Ask at the desk.`);
  assert.equal(read('trainers').content.heading, OLD.trainers.heading.toUpperCase());
  // The bullet they wrote stays where it was; the two seeded ones beside it change.
  assert.deepEqual(read('about').content.bullets, [byKey.about.bullets[0], 'Coaches on the floor from 6am to 10pm', byKey.about.bullets[2]]);
  // Their bar and their figures stay; the untouched seeded ones go, and the
  // band stays on because it still has something of the gym's own to show.
  assert.deepEqual(read('about').content.progress, [{ label: 'Strength & Conditioning', value: 70 }]);
  assert.deepEqual(read('stats').content.items, [
    { value: '430', suffix: '', label: 'Members' },
    { value: '40', suffix: '+', label: 'Classes a week' }
  ]);
  assert.equal(read('stats').enabled, true);
  // Their photos stay, in their groups; a stock photo they re-captioned is
  // theirs to remove; the stock ones around them go.
  assert.deepEqual(read('gallery').content.groups, [
    { title: 'Strength', images: [{ src: 'https://blob.example/gym/floor.jpg', alt: 'Our floor' }] },
    { title: 'Cardio', images: [{ src: STOCK_PHOTOS[4].src, alt: 'Our treadmills' }] },
    { title: 'Studio', images: [{ src: 'https://blob.example/gym/studio.jpg', alt: 'Studio' }] }
  ]);
  // And what they never touched is still cleaned.
  assert.equal(read('about').content.description, byKey.about.description);
  assert.equal(read('trainers').content.description, byKey.trainers.description);
});

test('a gym created with today\'s defaults, or with a page all of its own, has no text to change', () => {
  // Today's defaults: only the stock gallery is from the old seed.
  const fresh = DEFAULTS.map((section, index) => ({ _id: `fresh-${index}`, key: section.key, enabled: section.enabled !== false, content: clone(section.content) }));
  assert.deepEqual(planGym(fresh, DEFAULTS).map((plan) => plan.key), ['gallery']);

  const own = [
    { _id: 'a', key: 'about', enabled: true, content: { heading: 'Ours', description: 'Written by us.', bullets: ['One', 'Two'], progress: [{ label: 'Members who renew', value: 82 }] } },
    { _id: 'b', key: 'stats', enabled: true, content: { items: [{ value: '1200', suffix: '+', label: 'Members since we opened' }] } },
    { _id: 'c', key: 'gallery', enabled: true, content: { groups: [{ title: 'Strength', images: [{ src: '/uploads/own/rack.jpg', alt: 'Strength workout session' }] }] } },
    { _id: 'd', key: 'contact', enabled: true, content: {} },
    { _id: 'e', key: 'unknown-section', enabled: true, content: { heading: OLD.about.heading } }
  ];
  assert.deepEqual(planGym(own, DEFAULTS), []);

  // Odd rows are passed over, never thrown on.
  for (const row of [{ key: 'about' }, { key: 'stats', content: { items: 'none' } }, { key: 'gallery', content: { groups: [null, { title: 'Empty' }] } }, {}]) {
    assert.deepEqual(planSection(row, byKey[row.key]), { changes: [], set: {} });
  }
});

test('a stats band that was already hidden is emptied without being reported as newly hidden', () => {
  const stats = { _id: 's', key: 'stats', enabled: false, content: { items: clone(OLD_STATS) } };
  const { changes, set } = planSection(stats, byKey.stats);
  assert.deepEqual(set, { 'content.items': [] });
  assert.equal(changes.length, OLD_STATS.length);
});
