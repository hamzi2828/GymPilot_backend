// src/platform/platformDb.js
//
// The platform's own database: the list of gyms, the plans they are on, and
// the super-admin accounts that manage them. Separate from every gym's
// database, and never reachable through a gym's API token.

const mongoose = require('mongoose');
const { lazyModel } = require('./modelRegistry');

const PLATFORM_DB_NAME = process.env.PLATFORM_DB_NAME || 'gympilot_platform';

function platformConnection() {
  // useDb queues the wiring until the primary connection is open, so this is
  // safe to call before connect() has finished.
  return mongoose.connection.useDb(PLATFORM_DB_NAME, { useCache: true });
}

/**
 * A model bound to the platform database. Same proxy shape as tenantModel so
 * platform code reads like the rest of the codebase.
 */
function platformModel(name, schema) {
  return lazyModel(name, schema, platformConnection, 'platform');
}

module.exports = { PLATFORM_DB_NAME, platformConnection, platformModel };
