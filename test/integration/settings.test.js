// Settings → General → Business against a real MongoDB, through
// settingsController: what the admin page sends is what is saved, what the
// admin page reads back, and what the public site is given. The page used to
// send contactPhone / facebook / … while the API read mobileNumber /
// facebookUrl / …, so every edit was dropped without a word.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let settings;

const test = h.suite(async () => {
  settings = h.src('controller/settingsController');
  gym = await h.createGym('settings-gym');
});

const req = (extra = {}) => ({ headers: { host: 'api.settings.test' }, protocol: 'https', ...extra });
const get = () => h.call(settings.getSettings, req());
const put = (body) => h.call(settings.updateSettings, req({ body }));

// Exactly the keys the Business section of the admin page edits.
const BUSINESS = {
  siteName: 'Iron Works',
  contactEmail: 'Hello@IronWorks.test',
  mobileNumber: '+44 20 7946 0000',
  address: '1 Forge Lane, Sheffield',
  siteDescription: 'Strength and conditioning in the heart of Sheffield.',
  facebookUrl: 'https://facebook.com/ironworks',
  instagramUrl: 'instagram.com/ironworks',
  twitterUrl: 'https://x.com/ironworks',
  youtubeUrl: 'https://youtube.com/@ironworks',
  tiktokUrl: 'https://tiktok.com/@ironworks'
};

test('the Business section round-trips: PUT then GET returns every value', async () => {
  await h.inGym(gym, async () => {
    const saved = await put(BUSINESS);
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));

    const read = await get();
    assert.equal(read.statusCode, 200, JSON.stringify(read.body));
    const data = read.body.data;
    assert.equal(data.siteName, 'Iron Works');
    // Stored the way it is compared and linked: one case.
    assert.equal(data.contactEmail, 'hello@ironworks.test');
    assert.equal(data.mobileNumber, '+44 20 7946 0000');
    assert.equal(data.address, '1 Forge Lane, Sheffield');
    assert.equal(data.siteDescription, 'Strength and conditioning in the heart of Sheffield.');
    assert.equal(data.facebookUrl, 'https://facebook.com/ironworks');
    // A bare domain gains its scheme, so the footer link goes somewhere.
    assert.equal(data.instagramUrl, 'https://instagram.com/ironworks');
    assert.equal(data.twitterUrl, 'https://x.com/ironworks');
    assert.equal(data.youtubeUrl, 'https://youtube.com/@ironworks');
    assert.equal(data.tiktokUrl, 'https://tiktok.com/@ironworks');
  });
});

test('the public site is given the contact details, the description and the links', async () => {
  await h.inGym(gym, async () => {
    const res = await h.call(settings.getPublicSettings, req());
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.contactEmail, 'hello@ironworks.test');
    assert.equal(data.mobileNumber, '+44 20 7946 0000');
    assert.equal(data.siteDescription, 'Strength and conditioning in the heart of Sheffield.');
    assert.equal(data.instagramUrl, 'https://instagram.com/ironworks');
    assert.equal(data.tiktokUrl, 'https://tiktok.com/@ironworks');

    // The phone app's "contact us" reads the same two fields.
    const { branding } = h.src('services/branding');
    const app = await branding('https://api.settings.test');
    assert.equal(app.supportEmail, 'hello@ironworks.test');
    assert.equal(app.phone, '+44 20 7946 0000');
  });
});

test("the public site is given the gym's timezone, so every admin page's \"today\" is the gym's day", async () => {
  const karachi = await h.createGym('settings-karachi-gym', { timezone: 'Asia/Karachi', currency: 'PKR' });
  await h.inGym(karachi, async () => {
    const res = await h.call(settings.getPublicSettings, req());
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.ianaTimezone, 'Asia/Karachi');
    // The same value the Settings screen shows and edits.
    assert.equal((await get()).body.data.ianaTimezone, 'Asia/Karachi');
  });
});

test('saving the whole page back as it was read changes nothing and drops nothing', async () => {
  await h.inGym(gym, async () => {
    const before = (await get()).body.data;
    // What the admin page does on every save: the document it read, edited.
    const saved = await put({ ...before, siteDescription: 'Now with a sauna.' });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    const after = (await get()).body.data;
    assert.equal(after.siteDescription, 'Now with a sauna.');
    for (const key of ['contactEmail', 'mobileNumber', 'address', 'facebookUrl', 'instagramUrl', 'twitterUrl', 'youtubeUrl', 'tiktokUrl', 'currency', 'theme']) {
      assert.equal(after[key], before[key], key);
    }
  });
});

test('blank clears a field', async () => {
  await h.inGym(gym, async () => {
    const saved = await put({ contactEmail: '', youtubeUrl: '  ' });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    const data = (await get()).body.data;
    assert.equal(data.contactEmail, '');
    assert.equal(data.youtubeUrl, '');
    assert.equal(data.facebookUrl, 'https://facebook.com/ironworks');
  });
});

test('a link that is not a web address, or an email that is not one, is refused and nothing is saved', async () => {
  await h.inGym(gym, async () => {
    const script = await put({ facebookUrl: 'javascript:alert(document.cookie)', siteDescription: 'should not land' });
    assert.equal(script.statusCode, 400);
    assert.match(script.body.message, /Facebook/);

    const email = await put({ contactEmail: 'not an email', siteDescription: 'should not land' });
    assert.equal(email.statusCode, 400);

    const data = (await get()).body.data;
    assert.equal(data.facebookUrl, 'https://facebook.com/ironworks');
    assert.equal(data.siteDescription, 'Now with a sauna.');
  });
});
