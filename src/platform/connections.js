// src/platform/connections.js
//
// One MongoDB database per gym, on the cluster the platform already talks to
// unless the gym has been given its own connection string.
//
// The default case costs nothing extra: `useDb()` hands back a Connection that
// shares the primary connection's socket pool and client, so fifty gyms on
// one cluster are still one pool. A gym with its own URI (its own cluster,
// its own region, its own bill) gets a real second connection, cached for
// the life of the process.

const mongoose = require('mongoose');
const { ensureModelsOn } = require('./modelRegistry');

// Same shape as config/mongo.js uses for the primary connection.
const CONNECTION_OPTIONS = {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  family: 4
};

const dedicated = new Map(); // uri -> Connection

function databaseNameFor(slug) {
  const prefix = process.env.TENANT_DB_PREFIX || 'gympilot_';
  return `${prefix}${String(slug).replace(/[^a-z0-9_-]/gi, '_')}`;
}

async function getTenantConnection(gym) {
  const database = (gym && gym.database) || {};

  if (database.uri) {
    let connection = dedicated.get(database.uri);
    if (!connection) {
      connection = mongoose.createConnection(database.uri, CONNECTION_OPTIONS);
      dedicated.set(database.uri, connection);
    }
    await connection.asPromise();
    return ensureModelsOn(connection);
  }

  const name = database.name || databaseNameFor(gym.slug);
  // useCache: the same Connection object every time for this name, so each
  // gym's models are compiled once per process rather than once per request.
  const connection = mongoose.connection.useDb(name, { useCache: true });

  // A useDb() child copies the parent's last-heartbeat time once and never
  // hears another heartbeat, so mongoose's staleness check would report it
  // disconnected twenty seconds later -- and anything that waits on
  // readyState (createCollection, transactions, dropDatabase) would buffer
  // until it timed out. Queries are unaffected either way. Clearing the
  // stamp opts the child out of a check it cannot take part in; the parent
  // keeps watching the real heartbeats for both of them.
  connection._lastHeartbeatAt = null;

  return ensureModelsOn(connection);
}

/**
 * Drops a gym's database. Only ever reached from the explicit delete path
 * after the operator has typed the slug back; nothing on a request path
 * calls this.
 */
async function dropTenantDatabase(gym) {
  const database = (gym && gym.database) || {};

  // Straight through the driver rather than Connection#dropDatabase: a
  // useDb() child connection does not track the parent's heartbeats, so
  // mongoose can believe it is disconnected and buffer the call until it
  // times out, even while queries on it are working fine.
  if (database.uri) {
    const connection = await getTenantConnection(gym);
    await connection.getClient().db().dropDatabase();
    return;
  }

  const name = database.name || databaseNameFor(gym.slug);
  await mongoose.connection.asPromise();
  await mongoose.connection.getClient().db(name).dropDatabase();
}

module.exports = {
  getTenantConnection,
  dropTenantDatabase,
  databaseNameFor,
  CONNECTION_OPTIONS
};
