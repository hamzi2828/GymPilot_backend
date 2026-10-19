// vercel.json: the API is not something to index, /robots.txt reaches the
// app (which answers it) instead of a static file that was never deployed,
// and the one scheduled job is the daily reminders run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'vercel.json'), 'utf8'));

test('nothing in vercel.json invites a search engine in', () => {
  const robots = (config.headers || [])
    .flatMap((rule) => rule.headers || [])
    .filter((header) => String(header.key).toLowerCase() === 'x-robots-tag');
  for (const header of robots) assert.match(header.value, /noindex/);
  assert.doesNotMatch(JSON.stringify(config), /"index, follow"/);
});

test('every path, robots.txt included, is routed to the app', () => {
  assert.deepEqual(config.routes, [{ src: '/(.*)', dest: '/index.js' }]);
  assert.deepEqual(config.builds, [{ src: 'index.js', use: '@vercel/node' }]);
});

test('the only scheduled job is the daily reminders run', () => {
  assert.deepEqual(config.crons, [{ path: '/api/jobs/reminders', schedule: '0 3 * * *' }]);
});
