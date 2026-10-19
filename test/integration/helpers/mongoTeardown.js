// test/integration/helpers/mongoTeardown.js
//
// mongodb-memory-server stops mongod and then its "mongo_killer" watchdog,
// waiting up to twenty seconds for each to exit. On a busy machine the
// watchdog sometimes outlives that, and stop() rejects with
//
//   Process "killerProcess" didnt exit, enable debug for more information.
//
// The harness awaits its own stop() with a catch. But the library also calls
// stop() from its own async 'instanceError' listener (mongod closing while it
// is being stopped counts as an error), and there the same rejection has
// nobody to catch it: node:test reports an unhandled rejection and fails a
// file whose tests all passed.
//
// tolerateStopStall() makes the instance's stop() resolve on that one error,
// so no caller's copy of it can reject. What is left behind is the watchdog,
// which exits by itself once this process has. Any other error still rejects.

'use strict';

const STALL = /^Process "\w+" didn'?t exit/;

function isStopStall(error) {
  return !!error && STALL.test(String(error.message || error));
}

/**
 * Wraps the running instance's stop() of a MongoMemoryServer. Returns
 * whether it was wrapped (false when there is no instance, or it already is).
 */
function tolerateStopStall(server) {
  const instance = server && server.instanceInfo && server.instanceInfo.instance;
  if (!instance || typeof instance.stop !== 'function' || instance.stopStallTolerated) return false;
  const stop = instance.stop.bind(instance);
  instance.stop = () =>
    stop().catch((error) => {
      if (!isStopStall(error)) throw error;
      console.warn(`[integration] ignoring a teardown stall: ${error.message}`);
      return false;
    });
  instance.stopStallTolerated = true;
  return true;
}

module.exports = { isStopStall, tolerateStopStall };
