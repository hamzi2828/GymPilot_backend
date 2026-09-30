// src/services/backupStorage.js
//
// Where stored backups live: the Vercel Blob store (BLOB_READ_WRITE_TOKEN),
// under `<slug>/backups/<kind>/…`. What goes in is always encrypted first
// (services/backupCrypto.js) -- the store is public.
//
// Callers go through this module's object (`storage.save(...)`), never a
// destructured copy, so the integration tests can stand in for the store.

const { Readable } = require('stream');

/** Whether this server has somewhere to keep backups. */
function configured(env = process.env) {
  return !!env.BLOB_READ_WRITE_TOKEN;
}

/**
 * Stores `body` (a Readable) at `pathname`. Multipart, so the store takes it
 * in parts as it is produced and no size limit of a single request applies.
 * Resolves with { url, pathname }.
 */
async function save(pathname, body) {
  const { put } = require('@vercel/blob');
  const blob = await put(pathname, body, {
    access: 'public',
    contentType: 'application/octet-stream',
    multipart: true,
    // Unguessable, on top of being encrypted.
    addRandomSuffix: true,
    // A deleted backup should not linger in the edge cache.
    cacheControlMaxAge: 60
  });
  return { url: blob.url, pathname: blob.pathname };
}

/** The stored file as a Readable. */
async function open(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok || !res.body) {
    const error = new Error(res.status === 404 ? 'This backup is no longer in storage.' : `Storage answered ${res.status}.`);
    error.status = res.status === 404 ? 404 : 502;
    throw error;
  }
  return Readable.fromWeb(res.body);
}

/** Removes stored files; a file already gone is not an error. */
async function remove(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) return;
  const { del } = require('@vercel/blob');
  await del(list);
}

module.exports = { configured, save, open, remove };
