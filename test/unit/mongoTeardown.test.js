// The integration harness's guard against mongodb-memory-server's teardown
// stall (test/integration/helpers/mongoTeardown.js): a watchdog slow to exit
// resolves stop() for every caller, the library's own async listener
// included, while any other failure still rejects.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { isStopStall, tolerateStopStall } = require('../integration/helpers/mongoTeardown');

const STALL = 'Process "killerProcess" didnt exit, enable debug for more information.';

// Shaped like MongoInstance: stop() shares one promise between callers, and
// an async 'instanceError' listener calls it with nobody awaiting the result.
function fakeServer(error) {
  const instance = new EventEmitter();
  instance.stops = 0;
  instance.stop = async function stop() {
    instance.stops += 1;
    if (error) throw new Error(error);
    return true;
  };
  instance.on('instanceError', async () => {
    await instance.stop();
  });
  return { instanceInfo: { instance } };
}

test('only the "did not exit" stall counts as one', () => {
  assert.equal(isStopStall(new Error(STALL)), true);
  assert.equal(isStopStall(new Error('Process "mongodProcess" didn\'t exit, enable debug for more information.')), true);
  assert.equal(isStopStall(new Error('connect ECONNREFUSED 127.0.0.1:27017')), false);
  assert.equal(isStopStall(null), false);
});

test('a teardown stall resolves for the harness and for the library listener alike', async () => {
  const server = fakeServer(STALL);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(tolerateStopStall(server), true);
    assert.equal(tolerateStopStall(server), false, 'wrapped once');
    server.instanceInfo.instance.emit('instanceError', new Error('closed while stopping'));
    assert.equal(await server.instanceInfo.instance.stop(), false);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    console.warn = warn;
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(server.instanceInfo.instance.stops, 2);
});

test('any other failure to stop still rejects', async () => {
  const server = fakeServer('the database files are locked');
  tolerateStopStall(server);
  await assert.rejects(server.instanceInfo.instance.stop(), /files are locked/);
  assert.equal(tolerateStopStall({}), false, 'nothing running, nothing to wrap');
});
