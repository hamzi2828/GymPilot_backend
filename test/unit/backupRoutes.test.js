// Every backup route is for the gym's administrators: a signed-in account,
// `settings` at manage (which also writes the call to the audit log), and
// the administrator role -- in that order, so a refused attempt is recorded
// too. The cron route is the one exception: a machine with the shared
// secret, no account at all.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../../src/routes/backupRoutes');

test('every owner route is gated by auth, settings at manage and the administrator role, in that order', () => {
  const routes = router.stack.filter((layer) => layer.route && !layer.route.path.startsWith('/api/jobs/'));
  assert.ok(routes.length >= 1);
  for (const layer of routes) {
    const names = layer.route.stack.map((s) => s.handle.name);
    assert.deepEqual(names.slice(0, 3), ['auth', 'permissionGate', 'requireAdmin'], `${layer.route.path}: ${names.join(', ')}`);
    // Anything that hands data out is a write, so the gate records it in the
    // audit log. The list of backups (dates and sizes) is the only read.
    if (layer.route.path !== '/api/backups') {
      assert.ok(!layer.route.methods.get, `${layer.route.path} must not be a GET: reads are not audited`);
    }
  }
});

test('the cron route takes no account: the controller checks CRON_SECRET itself', () => {
  const cron = router.stack.filter((layer) => layer.route && layer.route.path === '/api/jobs/backups');
  assert.deepEqual(cron.map((layer) => Object.keys(layer.route.methods)[0]).sort(), ['get', 'post']);
  for (const layer of cron) assert.deepEqual(layer.route.stack.map((s) => s.handle.name), ['runDaily']);
});

test('nothing is gated router-wide', () => {
  assert.ok(router.stack.every((layer) => layer.route), 'no router.use() middleware that would run for other routes');
});
