// src/platform/dbNames.js
//
// How databases are named.
//
// The database in MONGO_URI is the platform's home: the list of gyms, the
// plans, the super admins -- and the data of the gym the platform started
// with. Every gym created since gets its own database beside it, named after
// it: with MONGO_URI ending in `/GymPilot`, new gyms land in `GymPilot_gym1`,
// `GymPilot_gym2`, … Both can be overridden (PLATFORM_DB_NAME,
// TENANT_DB_PREFIX) but do not need to be.

const mongoose = require('mongoose');

function databaseInUri(uri) {
  // scheme://[user:pass@]hosts/<database>[?options]
  const match = /^[a-z0-9+.-]+:\/\/(?:[^@/?]*@)?[^/?]*\/([^/?#]*)/i.exec(String(uri || ''));
  if (!match || !match[1]) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** The database MONGO_URI points at. */
function mainDatabaseName() {
  return databaseInUri(process.env.MONGO_URI) || (mongoose.connection && mongoose.connection.name) || 'test';
}

/** Where gyms, plans and super admins live. */
function platformDatabaseName() {
  return process.env.PLATFORM_DB_NAME || mainDatabaseName();
}

/** What a new gym's database name starts with. */
function tenantDatabasePrefix() {
  return process.env.TENANT_DB_PREFIX || `${mainDatabaseName()}_`;
}

function databaseNameFor(slug) {
  return `${tenantDatabasePrefix()}${String(slug).replace(/[^a-z0-9_-]/gi, '_')}`;
}

/**
 * Databases that hold more than one gym's worth of data -- or MongoDB's
 * own -- and must never go through the per-gym drop path.
 */
function isProtectedDatabase(name) {
  return ['admin', 'local', 'config', mainDatabaseName(), platformDatabaseName()].includes(String(name || ''));
}

module.exports = {
  databaseInUri,
  mainDatabaseName,
  platformDatabaseName,
  tenantDatabasePrefix,
  databaseNameFor,
  isProtectedDatabase
};
