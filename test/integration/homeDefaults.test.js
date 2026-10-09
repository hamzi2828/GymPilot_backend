// A new gym's homepage, against a real MongoDB: the website is not sent the
// stats band until the gym has entered figures of its own, the admin still
// sees it (switched off, empty) so it can be filled in, and switching it on
// with real numbers puts it on the site.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let sections;

const test = h.suite(async () => {
  sections = h.src('controller/homeSectionController');
  gym = await h.createGym('home-defaults-gym');
});

const call = (handler, req) => h.inGym(gym, () => h.call(handler, req));

test('a new gym\'s website gets no stats band and no invented figures', async () => {
  const res = await call(sections.getPublicSections);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const keys = res.body.data.map((section) => section.key);
  assert.deepEqual(keys, ['about', 'classes', 'gallery', 'trainers', 'testimonials', 'contact', 'blogs']);

  const about = res.body.data.find((section) => section.key === 'about').content;
  assert.deepEqual(about.progress, []);
  assert.doesNotMatch(JSON.stringify({ ...about, image: '' }), /\d/);
});

test('the admin sees the stats band switched off and empty, ready to fill in', async () => {
  const res = await call(sections.getAllSections);
  const stats = res.body.data.find((section) => section.key === 'stats');
  assert.equal(stats.enabled, false);
  assert.deepEqual(stats.content.items, []);
});

test('once the gym enters its own figures and switches the band on, the website shows them', async () => {
  const HomeSection = h.src('models/homeSectionModel');
  await h.inGym(gym, () => HomeSection.updateOne({ key: 'stats' }, { $set: { enabled: true, 'content.items': [{ value: '85', suffix: '', label: 'Members' }] } }));

  const res = await call(sections.getPublicSections);
  const stats = res.body.data.find((section) => section.key === 'stats');
  assert.deepEqual(stats.content.items, [{ value: '85', suffix: '', label: 'Members' }]);
});

// scripts/cleanHomeSeed.js, as it runs on a gym created before the defaults
// were rewritten (the decision itself: test/unit/cleanHomeSeed.test.js).
test('the clean-up takes the old seeded claims off an older gym\'s website and leaves what the gym wrote', async () => {
  const HomeSection = h.src('models/homeSectionModel');
  const { cleanHomeSeed, OLD, OLD_BULLETS, OLD_PROGRESS, OLD_STATS } = require('../../scripts/lib/homeSeed');
  const older = await h.createGym('home-older-gym');
  const inOlder = (fn) => h.inGym(older, fn);
  const site = async () => (await inOlder(() => h.call(sections.getPublicSections))).body.data;

  // The gym as it was created: the old words, the stats band on show --
  // and one heading the owner has since written themselves.
  await inOlder(async () => {
    await h.call(sections.getPublicSections);
    await HomeSection.updateOne({ key: 'about' }, { $set: { 'content.heading': 'Iron Works, Sheffield', 'content.description': OLD.about.description, 'content.bullets': OLD_BULLETS, 'content.progress': OLD_PROGRESS } });
    await HomeSection.updateOne({ key: 'stats' }, { $set: { enabled: true, 'content.items': OLD_STATS } });
    await HomeSection.updateOne({ key: 'trainers' }, { $set: { 'content.heading': OLD.trainers.heading, 'content.description': OLD.trainers.description } });
  });
  const before = JSON.stringify(await site());
  for (const claim of ['24/7 access for members', 'Certified coaches on the floor at all times', 'Active members', 'unsplash.com']) assert.ok(before.includes(claim), claim);

  // The dry run reports and changes nothing.
  const dry = await inOlder(() => cleanHomeSeed(HomeSection));
  assert.equal(dry.applied, false);
  assert.ok(dry.count >= 12, `reported ${dry.count}`);
  assert.equal(JSON.stringify(await site()), before);

  const done = await inOlder(() => cleanHomeSeed(HomeSection, { apply: true }));
  assert.equal(done.count, dry.count);
  const after = await site();
  const stored = JSON.stringify(after);
  for (const claim of ['24/7', 'Certified coaches', 'Active members', 'certified, insured', 'unsplash.com']) assert.equal(stored.includes(claim), false, claim);
  // The band of invented figures is off the site; the gallery has no stock photos.
  assert.deepEqual(after.map((section) => section.key), ['about', 'classes', 'gallery', 'trainers', 'testimonials', 'contact', 'blogs']);
  assert.deepEqual(after.find((section) => section.key === 'gallery').content.groups, []);
  const about = after.find((section) => section.key === 'about').content;
  assert.equal(about.heading, 'Iron Works, Sheffield', 'the owner\'s own heading is untouched');
  assert.deepEqual(about.progress, []);
  assert.equal(about.bullets.length, 3);
  assert.equal(about.ctaLink, '/packages');

  // A second run has nothing left to do.
  assert.equal((await inOlder(() => cleanHomeSeed(HomeSection, { apply: true }))).count, 0);
});
