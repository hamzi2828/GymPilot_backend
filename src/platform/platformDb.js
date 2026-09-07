// src/platform/platformDb.js
//
// The platform's own collections: the list of gyms, the plans they are on,
// and the super-admin accounts that manage them. They live in the main
// database (the one MONGO_URI names -- see dbNames.js) and are never
// reachable through a gym's API token.

const mongoose = require('mongoose');
const { lazyModel } = require('./modelRegistry');
const { platformDatabaseName } = require('./dbNames');

function platformConnection() {
  // useDb queues the wiring until the primary connection is open, so this is
  // safe to call before connect() has finished. With useCache the platform
  // and a gym that shares this database get the same Connection object; the
  // model names do not overlap, so both sets compile on it side by side.
  return mongoose.connection.useDb(platformDatabaseName(), { useCache: true });
}

/**
 * A model bound to the platform database. Same proxy shape as tenantModel so
 * platform code reads like the rest of the codebase.
 */
function platformModel(name, schema) {
  return lazyModel(name, schema, platformConnection, 'platform');
}

module.exports = { platformDatabaseName, platformConnection, platformModel };
