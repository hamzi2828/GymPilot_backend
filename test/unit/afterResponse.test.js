// afterResponse: work a request sets off without waiting for it. Off Vercel
// it just runs; on Vercel it is handed to the platform's waitUntil (read by
// @vercel/functions from the request context Vercel installs on globalThis),
// so the function is not frozen half-way through an email. Either way it
// never rejects into the caller, and it starts inside the caller's
// AsyncLocalStorage context -- which is how a send keeps its gym.

const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');

const { afterResponse, onVercel } = require('../../src/services/afterResponse');

const CONTEXT = Symbol.for('@vercel/request-context');

// What Vercel's runtime puts on globalThis for each request.
function installVercelContext() {
  const registered = [];
  globalThis[CONTEXT] = { get: () => ({ waitUntil: (promise) => registered.push(promise) }) };
  return registered;
}

function withVercel(fn) {
  const previous = process.env.VERCEL;
  process.env.VERCEL = '1';
  const registered = installVercelContext();
  return Promise.resolve(fn(registered)).finally(() => {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
    delete globalThis[CONTEXT];
  });
}

async function quietly(fn) {
  const error = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await fn(logged);
  } finally {
    console.error = error;
  }
}

test('Vercel is recognised by the VERCEL variable it sets', () => {
  assert.equal(onVercel({ VERCEL: '1' }), true);
  assert.equal(onVercel({}), false);
  assert.equal(onVercel({ VERCEL: '' }), false);
});

test('off Vercel the work runs and its result comes back; waitUntil is never touched', async () => {
  const previous = process.env.VERCEL;
  delete process.env.VERCEL;
  const registered = installVercelContext();
  try {
    let ran = false;
    const result = await afterResponse(async () => {
      ran = true;
      return 'sent';
    }, 'test');
    assert.equal(ran, true);
    assert.equal(result, 'sent');
    assert.equal(registered.length, 0);
  } finally {
    delete globalThis[CONTEXT];
    if (previous !== undefined) process.env.VERCEL = previous;
  }
});

test('on Vercel the work is registered with waitUntil, and what is registered waits for the work', () =>
  withVercel(async (registered) => {
    let finish;
    const gate = new Promise((resolve) => {
      finish = resolve;
    });
    let done = false;
    const returned = afterResponse(async () => {
      await gate;
      done = true;
      return 'delivered';
    }, 'test');

    assert.equal(registered.length, 1, 'one promise handed to waitUntil');
    assert.equal(done, false, 'the caller is not held up');
    finish();
    assert.equal(await registered[0], 'delivered');
    assert.equal(done, true);
    assert.equal(await returned, 'delivered');
  }));

test('a promise already under way is accepted as well as a function', () =>
  withVercel(async (registered) => {
    const result = await afterResponse(Promise.resolve(42), 'test');
    assert.equal(result, 42);
    assert.equal(registered.length, 1);
  }));

test('a failure is logged with its label and never rejects -- thrown or rejected', () =>
  quietly(async (logged) => {
    assert.equal(await afterResponse(() => { throw new Error('smtp down'); }, 'welcome email'), undefined);
    assert.equal(await afterResponse(async () => { throw new Error('expo down'); }, 'push'), undefined);
    assert.equal(await afterResponse(Promise.reject(new Error('gone')), 'reset link'), undefined);
    assert.equal(logged.length, 3);
    assert.match(logged[0], /welcome email failed: smtp down/);
    assert.match(logged[1], /push failed: expo down/);
    assert.match(logged[2], /reset link failed: gone/);
  }));

test('on Vercel a failing send is still registered, and what is registered does not reject', () =>
  withVercel((registered) =>
    quietly(async () => {
      await afterResponse(async () => { throw new Error('nope'); }, 'test');
      assert.equal(registered.length, 1);
      assert.equal(await registered[0], undefined);
    })
  ));

test('the work starts at once, inside the caller\'s context (the gym it was sent for)', async () => {
  const storage = new AsyncLocalStorage();
  let startedSync = false;
  const seen = await storage.run({ gym: 'ironworks' }, () => {
    const pending = afterResponse(async () => {
      startedSync = true;
      await new Promise((resolve) => setImmediate(resolve));
      return storage.getStore().gym;
    }, 'test');
    assert.equal(startedSync, true, 'called before afterResponse returned');
    return pending;
  });
  assert.equal(seen, 'ironworks');
});

test('without a request context (a script, a test) waitUntil is a no-op and the work still runs', async () => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = '1';
  delete globalThis[CONTEXT];
  try {
    assert.equal(await afterResponse(async () => 'ran', 'test'), 'ran');
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});
