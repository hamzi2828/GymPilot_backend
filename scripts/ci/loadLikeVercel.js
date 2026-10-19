// scripts/ci/loadLikeVercel.js
//
// Loads index.js the way Vercel's function runtime does: without
// require(esm). A dependency that has gone ESM-only loads fine on a recent
// Node and then crashes the deployed API on its first request (it happened
// with sanitize-html). Run it with the flag, or it proves nothing:
//
//   node --no-experimental-require-module scripts/ci/loadLikeVercel.js
//
// No database and no port: mongoose.connect is replaced by a connection that
// never opens and app.listen by a no-op that keeps the app, the way
// test/integration/serverBasics.test.js loads index.js. .env is never read.
// Every dependency in package.json is then required by name as well, since
// some are only required inside a handler.

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

if (process.features && process.features.require_module) {
  console.error('[load check] Run this with --no-experimental-require-module: this Node loads ES modules through require(), which Vercel does not.');
  process.exit(2);
}

process.env.NODE_ENV = 'production';
// Never connected to: mongoose.connect is replaced below.
process.env.MONGO_URI = 'mongodb://127.0.0.1:9/__load_check__';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'load-check-secret-load-check-secret-0000';

const dotenvPath = require.resolve('dotenv', { paths: [ROOT] });
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, exports: { config: () => ({ parsed: {} }) } };

const mongoose = require(require.resolve('mongoose', { paths: [ROOT] }));
mongoose.connect = () => new Promise(() => {});

const express = require(require.resolve('express', { paths: [ROOT] }));
let app = null;
express.application.listen = function captured() {
  app = this;
  return { close() {} };
};

try {
  require(path.join(ROOT, 'index.js'));
  if (typeof app !== 'function') throw new Error('index.js never called app.listen()');

  const { dependencies = {} } = require(path.join(ROOT, 'package.json'));
  for (const name of Object.keys(dependencies)) require(require.resolve(name, { paths: [ROOT] }));

  console.log(`[load check] index.js and ${Object.keys(dependencies).length} dependencies load on Node ${process.version} without require(esm).`);
  process.exit(0);
} catch (error) {
  console.error('[load check] FAILED: this would crash on Vercel.');
  console.error(error);
  process.exit(1);
}
