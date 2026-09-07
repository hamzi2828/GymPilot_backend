process.env.MONGO_URI = 'mongodb+srv://user:p%40ss@cluster.example.net/gymwear?appName=GymPilot';
delete process.env.PLATFORM_DB_NAME;
delete process.env.TENANT_DB_PREFIX;

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const names = require('../../src/platform/dbNames');

test('the main database is read from MONGO_URI', () => {
  assert.equal(names.databaseInUri('mongodb+srv://u:p@host/gymwear?x=1'), 'gymwear');
  assert.equal(names.databaseInUri('mongodb://a:27017,b:27017/my%20db'), 'my db');
  assert.equal(names.databaseInUri('mongodb://localhost:27017'), '');
  assert.equal(names.mainDatabaseName(), 'gymwear');
});

test('platform records live in the main database and gyms beside it', () => {
  assert.equal(names.platformDatabaseName(), 'gymwear');
  assert.equal(names.tenantDatabasePrefix(), 'gymwear_');
  assert.equal(names.databaseNameFor('gym1'), 'gymwear_gym1');
  assert.equal(names.databaseNameFor('iron works!'), 'gymwear_iron_works_');
});

test('environment overrides both names', () => {
  process.env.PLATFORM_DB_NAME = 'platform_only';
  process.env.TENANT_DB_PREFIX = 'tenant_';
  try {
    assert.equal(names.platformDatabaseName(), 'platform_only');
    assert.equal(names.databaseNameFor('gym1'), 'tenant_gym1');
    assert.equal(names.isProtectedDatabase('platform_only'), true);
  } finally {
    delete process.env.PLATFORM_DB_NAME;
    delete process.env.TENANT_DB_PREFIX;
  }
});

test('the main and platform databases can never be dropped as a gym', () => {
  assert.equal(names.isProtectedDatabase('gymwear'), true);
  assert.equal(names.isProtectedDatabase('admin'), true);
  assert.equal(names.isProtectedDatabase('gymwear_gym1'), false);
});
