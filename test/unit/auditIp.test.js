// The admin audit trail (middleware/requirePermission.js) records the
// address express trusts -- req.ip, the hop Vercel's proxy wrote -- not the
// first X-Forwarded-For entry, which is whatever the caller sent. No
// database: the log write is stood in for.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
require('mongoose').set('autoIndex', false);
require('mongoose').set('autoCreate', false);
require('mongoose').set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const requirePermission = require('../../src/middleware/requirePermission');
const AdminAuditLog = require('../../src/models/adminAuditLogModel');
const { runWithTenant } = require('../../src/platform/tenantContext');

const gym = { _id: '00000000000000000000a1b1', slug: 'unit-audit-ip', database: { name: 'gympilot_unit_audit_ip' } };

test('a write that passes the gate is logged with req.ip, whatever X-Forwarded-For says', async () => {
  await runWithTenant(gym, async () => {
    const rows = [];
    AdminAuditLog.record = (row) => {
      rows.push(row);
      return Promise.resolve(null);
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    let passed = false;
    await requirePermission('classes')(
      {
        method: 'POST',
        originalUrl: '/api/classes?x=1',
        body: {},
        user: { role: 'admin', email: 'boss@gym.test' },
        headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'user-agent': 'unit' },
        ip: '203.0.113.9',
        socket: { remoteAddress: '10.0.0.1' }
      },
      res,
      () => {
        passed = true;
      }
    );
    assert.equal(passed, true);
    res.emit('finish');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ip, '203.0.113.9');
    assert.equal(rows[0].path, '/api/classes');
  });
});
