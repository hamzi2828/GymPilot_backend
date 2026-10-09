// The server's own plumbing (index.js), against a real MongoDB: the health
// check waits for a connection instead of reporting a cold start as an
// outage, an address nothing answers gets the API's JSON 404, a malformed id
// that reaches the error handler is a 400, request bodies are capped at an
// ordinary size, localhost is a CORS origin only outside production, and a
// short JWT_SECRET is warned about at boot without stopping it.
//
// index.js is loaded here as it runs: its app is captured at listen() and
// served on a port of this test's own. .env is never read -- dotenv is
// replaced first -- and the production run is a child process started in an
// empty directory with only the variables given to it.

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');
const h = require('./helpers/harness');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX = path.join(ROOT, 'index.js');
const SLUG = 'server-basics-gym';

let app;
let server;
let base;
let mongoose;

const test = h.suite(async () => {
  await h.createGym(SLUG);
  mongoose = h.state.mongoose;

  const dotenvPath = require.resolve('dotenv');
  require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, exports: { config: () => ({ parsed: {} }) } };

  const express = require('express');
  const listen = express.application.listen;
  express.application.listen = function captured() {
    app = this;
    return { close() {} };
  };
  try {
    require(INDEX);
  } finally {
    express.application.listen = listen;
  }

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

require('node:test').after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const inGym = (headers = {}) => ({ 'x-tenant-slug': SLUG, ...headers });

test('an address nothing answers is a JSON 404, in or out of /api', async () => {
  for (const [method, url] of [['GET', '/api/no-such-thing'], ['GET', '/no/such/page'], ['POST', '/api/gymfolio/no-such-thing']]) {
    const res = await fetch(base + url, { method, headers: inGym() });
    assert.equal(res.status, 404, url);
    assert.match(res.headers.get('content-type'), /application\/json/, url);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(typeof body.message, 'string');
  }
});

test('crawlers are told to stay out: robots.txt disallows everything and every response says noindex', async () => {
  // No gym named: robots.txt belongs to the API, not to a gym.
  const robots = await fetch(`${base}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /text\/plain/);
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n');

  for (const url of ['/robots.txt', '/', '/health', '/api/no-such-thing']) {
    const res = await fetch(base + url, { headers: inGym() });
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', url);
  }
});

test('a malformed id that reaches the error handler is a 400, not a 500', () => {
  const handler = (app.router || app._router).stack.map((layer) => layer.handle).find((handle) => handle.length === 4);
  assert.ok(handler, 'index.js has an error handler');
  const res = h.fakeRes();
  handler(new mongoose.Error.CastError('ObjectId', 'not-an-id', '_id'), {}, res, () => {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.doesNotMatch(JSON.stringify(res.body), /not-an-id|ObjectId|_id/, 'and says nothing about the schema');
});

test('a JSON or form body over 1 MB is refused with a 413; an ordinary one is read', async () => {
  const post = (body, type = 'application/json') =>
    fetch(`${base}/user/login`, { method: 'POST', headers: inGym({ 'content-type': type }), body });

  const large = await post(JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(2 * 1024 * 1024) }));
  assert.equal(large.status, 413);
  assert.equal((await large.json()).error, 'Payload too large');

  const form = await post(`email=a%40b.test&password=${'x'.repeat(2 * 1024 * 1024)}`, 'application/x-www-form-urlencoded');
  assert.equal(form.status, 413);

  // 200 KB -- twice Express's own default -- still gets as far as the route.
  const ordinary = await post(JSON.stringify({ email: 'nobody@basics.test', password: 'wrong', note: 'x'.repeat(200 * 1024) }));
  assert.notEqual(ordinary.status, 413);
  assert.ok(ordinary.status < 500, `got ${ordinary.status}`);
});

test('outside production a developer\'s localhost may call the API', async () => {
  const res = await fetch(`${base}/`, { headers: { origin: 'http://localhost:3000' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('in production localhost is not a CORS origin, and a short JWT_SECRET is warned about without stopping the server', async () => {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gympilot-basics-'));
  const secret = 'short-secret-1';
  const child = spawn(process.execPath, [INDEX], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: 'production',
      PORT: String(port),
      MONGO_URI: process.env.MONGO_URI,
      PLATFORM_DB_NAME: process.env.PLATFORM_DB_NAME,
      TENANT_DB_PREFIX: process.env.TENANT_DB_PREFIX,
      JWT_SECRET: secret,
      SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY,
      PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
      QR_TOKEN_SECRET: process.env.QR_TOKEN_SECRET
    }
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  try {
    const started = Date.now();
    while (!/Server is running/.test(output)) {
      assert.equal(child.exitCode, null, `the server stopped:\n${output}`);
      assert.ok(Date.now() - started < 60000, `the server did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.match(output, /WARNING: JWT_SECRET is shorter than 32 characters/);
    assert.equal(output.includes(secret), false, 'the warning does not print the secret');

    const origin = (value) => fetch(`http://127.0.0.1:${port}/`, { headers: { origin: value } }).then((res) => res.headers.get('access-control-allow-origin'));
    assert.equal(await origin('http://localhost:3000'), null);
    assert.equal(await origin('http://localhost:3001'), null);
    // A registered gym's own website still may.
    assert.equal(await origin(`https://${SLUG}.test`), `https://${SLUG}.test`);
  } finally {
    child.kill();
    await new Promise((resolve) => (child.exitCode === null ? child.once('exit', resolve) : resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// Last: it drops the connection the tests above were using.
test('the health check waits for a connection that is not there yet', async () => {
  const warm = await fetch(`${base}/health`);
  assert.equal(warm.status, 200);

  await mongoose.disconnect();
  assert.notEqual(mongoose.connection.readyState, 1);

  const cold = await fetch(`${base}/health`);
  assert.equal(cold.status, 200, 'a cold start is not an outage');
  const body = await cold.json();
  assert.equal(body.status, 'healthy');
  assert.equal(body.database.status, 'connected');
});
