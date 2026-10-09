// A saved secret stays with the place it was saved for, against a real
// MongoDB, through settingsController.
//
// Whoever may edit Settings only ever sees a secret's masked preview. But
// the mail host and the SMS / WhatsApp gateway address sit beside those
// secrets, and saving a new address with the secret box untouched used to
// keep the secret: the next email or text then gave the gym's SMTP password,
// or its gateway token, to whatever server the address now named. A changed
// address needs its secret typed again. A save that changes neither -- the
// admin page sends every field every time -- works as before.
//
// Also pinned here: every write under /settings needs the tab at manage.

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const h = require('./helpers/harness');

let gym;
let settings;
let Settings;
let User;

const SMTP = { host: 'smtp.gym-mail.test', port: 587, secure: false, user: 'desk@gym-mail.test', pass: 'the-real-smtp-password', fromName: 'Iron Works', fromEmail: 'desk@gym-mail.test' };
const MESSAGING = {
  sms: { provider: 'http', webhookUrl: 'https://sms.gateway.test/send', webhookToken: 'sms-gateway-token-1234' },
  whatsapp: { provider: 'http', webhookUrl: 'https://wa.gateway.test/send', webhookToken: 'wa-gateway-token-5678' }
};

const test = h.suite(async () => {
  settings = h.src('controller/settingsController');
  Settings = h.src('models/settings');
  User = h.src('models/user');
  gym = await h.createGym('settings-secrets-gym');
  await h.inGym(gym, async () => {
    await h.src('services/roleService').ensureDefaultRoles();
    const first = await put({ smtp: SMTP, messaging: MESSAGING });
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  });
});

const put = (body) => h.call(settings.updateSettings, { headers: { host: 'api.settings.test' }, protocol: 'https', body });
const shown = async () => (await h.call(settings.getSettings, { headers: { host: 'api.settings.test' }, protocol: 'https' })).body.data;
// What is really stored, opened: the secrets as the mail and text senders read them.
const kept = async () => {
  const doc = await Settings.getSettings();
  return { smtp: doc.smtp, sms: doc.messaging.sms, whatsapp: doc.messaging.whatsapp };
};

test('an ordinary save sends the masked secrets back and keeps them', async () => {
  await h.inGym(gym, async () => {
    const page = await shown();
    assert.notEqual(page.smtp.pass, SMTP.pass, 'the page never holds the password');
    assert.equal(page.smtp.passSet, true);

    // The admin page: every field, as it was read, with one thing edited.
    const res = await put({ ...page, siteName: 'Iron Works', smtp: { ...page.smtp, fromName: 'Iron Works Gym' }, messaging: page.messaging });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.warnings, []);

    const after = await kept();
    assert.equal(after.smtp.pass, SMTP.pass);
    assert.equal(after.smtp.fromName, 'Iron Works Gym');
    assert.equal(after.sms.webhookToken, MESSAGING.sms.webhookToken);
    assert.equal(after.whatsapp.webhookToken, MESSAGING.whatsapp.webhookToken);

    // The same host typed with other capitals or a stray space is the same host.
    const same = await put({ smtp: { ...page.smtp, host: ' SMTP.Gym-Mail.test ' } });
    assert.equal(same.statusCode, 200, JSON.stringify(same.body));
    assert.equal((await kept()).smtp.pass, SMTP.pass);
    await put({ smtp: { host: SMTP.host } });
  });
});

test('a new mail host does not inherit the saved password', async () => {
  await h.inGym(gym, async () => {
    const page = await shown();

    for (const smtp of [
      { ...page.smtp, host: 'smtp.attacker.test' }, // the masked preview, untouched
      { host: 'smtp.attacker.test' }, // no password field at all
      { host: 'smtp.attacker.test', pass: undefined }
    ]) {
      const res = await put({ siteName: 'Changed with it', smtp });
      assert.equal(res.statusCode, 400, JSON.stringify(res.body));
      assert.equal(res.body.code, 'SECRET_REQUIRED');
      assert.equal(res.body.field, 'smtp.pass');
      assert.match(res.body.message, /type its password again/);
    }
    const untouched = await kept();
    assert.equal(untouched.smtp.host, SMTP.host);
    assert.equal(untouched.smtp.pass, SMTP.pass);
    assert.notEqual((await shown()).siteName, 'Changed with it', 'nothing else in a refused save is written');

    // Moving to a new mail provider, with its own password: fine.
    const moved = await put({ smtp: { ...page.smtp, host: 'smtp.new-provider.test', pass: 'the-new-providers-password' } });
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));
    const after = await kept();
    assert.equal(after.smtp.host, 'smtp.new-provider.test');
    assert.equal(after.smtp.pass, 'the-new-providers-password');

    // Or clearing it, to fill in later.
    const cleared = await put({ smtp: { host: 'smtp.later.test', pass: '' } });
    assert.equal(cleared.statusCode, 200, JSON.stringify(cleared.body));
    assert.equal((await kept()).smtp.pass, '');
    // With no password saved there is nothing to protect: the host is free to change.
    assert.equal((await put({ smtp: { host: 'smtp.again.test' } })).statusCode, 200);
  });
});

test('nor does a new gateway address inherit the saved token', async () => {
  await h.inGym(gym, async () => {
    const page = await shown();
    assert.notEqual(page.messaging.sms.webhookToken, MESSAGING.sms.webhookToken);

    for (const [kind, label] of [['sms', 'SMS'], ['whatsapp', 'WhatsApp']]) {
      for (const patch of [{ webhookUrl: 'https://attacker.test/collect' }, { ...page.messaging[kind], webhookUrl: 'https://attacker.test/collect' }]) {
        const res = await put({ messaging: { ...page.messaging, [kind]: patch } });
        assert.equal(res.statusCode, 400, `${kind}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.code, 'SECRET_REQUIRED');
        assert.equal(res.body.field, `messaging.${kind}.webhookToken`);
        assert.match(res.body.message, new RegExp(`${label} gateway address`));
      }
    }
    let after = await kept();
    assert.equal(after.sms.webhookUrl, MESSAGING.sms.webhookUrl);
    assert.equal(after.sms.webhookToken, MESSAGING.sms.webhookToken);
    assert.equal(after.whatsapp.webhookToken, MESSAGING.whatsapp.webhookToken);

    // What the admin page sends when the address was edited and the token
    // box left alone: the token cleared. The old one does not travel.
    const cleared = await put({ messaging: { ...page.messaging, sms: { ...page.messaging.sms, webhookUrl: 'https://sms.new-gateway.test/send', webhookToken: '' } } });
    assert.equal(cleared.statusCode, 200, JSON.stringify(cleared.body));
    after = await kept();
    assert.equal(after.sms.webhookUrl, 'https://sms.new-gateway.test/send');
    assert.equal(after.sms.webhookToken, '');
    assert.equal(after.whatsapp.webhookToken, MESSAGING.whatsapp.webhookToken, 'the other channel is untouched');

    // A new address with its own token.
    const moved = await put({ messaging: { whatsapp: { webhookUrl: 'https://wa.new-gateway.test/send', webhookToken: 'the-new-wa-token' } } });
    assert.equal(moved.statusCode, 200, JSON.stringify(moved.body));
    assert.equal((await kept()).whatsapp.webhookToken, 'the-new-wa-token');
  });
});

test('every write under Settings needs the tab at manage, not just to see it', async () => {
  const router = h.src('routes/allRoutes');
  const WRITES = [
    ['put', '/settings'],
    ['post', '/settings/logo'],
    ['delete', '/settings/logo'],
    ['post', '/settings/footer-logo'],
    ['delete', '/settings/footer-logo'],
    ['post', '/settings/reset'],
    ['post', '/settings/test-smtp']
  ];

  await h.inGym(gym, async () => {
    const password = await bcrypt.hash('correct-horse-1', 4);
    // The seeded Manager role sees Settings and may not change it.
    const viewer = await User.create({ firstName: 'Max', lastName: 'Viewer', email: 'max@settings-secrets.test', role: 'manager', password, employment: { isStaff: true } });
    const owner = await User.create({ firstName: 'Ada', lastName: 'Owner', email: 'ada@settings-secrets.test', role: 'admin', password, employment: { isStaff: true } });

    for (const [method, path] of WRITES) {
      const layer = router.stack.find((entry) => entry.route && entry.route.path === path && entry.route.methods[method]);
      assert.ok(layer, `${method.toUpperCase()} ${path} is routed`);
      // auth, then the permission gate, then whatever handles the request.
      const gate = layer.route.stack[1].handle;
      assert.equal(gate.name, 'permissionGate', `${method.toUpperCase()} ${path} is gated`);

      const ask = async (account) => {
        const res = h.fakeRes();
        res.on = () => {};
        let passed = false;
        await gate({ method: method.toUpperCase(), originalUrl: path, headers: {}, user: { id: String(account._id), role: account.role } }, res, () => {
          passed = true;
        });
        return { passed, res };
      };

      const refused = await ask(viewer);
      assert.equal(refused.passed, false, `${method.toUpperCase()} ${path} with view only`);
      assert.equal(refused.res.statusCode, 403);
      assert.match(refused.res.body.message, /manage access to settings/);
      assert.equal((await ask(owner)).passed, true);
    }

    // Reading the page is what view is for.
    const read = router.stack.find((entry) => entry.route && entry.route.path === '/settings' && entry.route.methods.get);
    const res = h.fakeRes();
    let passed = false;
    await read.route.stack[1].handle({ method: 'GET', originalUrl: '/settings', headers: {}, user: { id: String(viewer._id), role: 'manager' } }, res, () => {
      passed = true;
    });
    assert.equal(passed, true);
  });
});
