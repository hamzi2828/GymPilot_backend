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
