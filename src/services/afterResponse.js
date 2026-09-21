// src/services/afterResponse.js
//
// Work a request sets off but nobody should wait for: the confirmation
// email, the push, the password-reset link.
//
// On a long-lived server a promise nobody awaits simply runs to the end. On
// Vercel it does not. The function is frozen, or torn down, once the
// response has gone, and whatever was still in flight -- an SMTP
// conversation half-way through, a push waiting on Expo -- is dropped with no
// error anybody sees. `waitUntil` (@vercel/functions) is how a function tells
// the platform "keep me alive until this settles", so on Vercel the work is
// registered with it; anywhere else it just runs.
//
// Two promises this makes to callers:
//
//   * the work never rejects into them: a failure is logged with its label
//     and swallowed, as the fire-and-forget sends always were;
//   * a function is called straight away, synchronously, so it starts inside
//     the request's tenant context (AsyncLocalStorage) and keeps that gym's
//     database for everything it goes on to await.

// undefined: not looked up yet. null: not available.
let vercelWaitUntil;

function waitUntilFn() {
  if (vercelWaitUntil !== undefined) return vercelWaitUntil;
  try {
    const { waitUntil } = require('@vercel/functions');
    vercelWaitUntil = typeof waitUntil === 'function' ? waitUntil : null;
  } catch (error) {
    // Without it the work still runs -- it just may be cut short on Vercel,
    // which is how every send behaved before this file existed.
    console.warn('[after-response] @vercel/functions is not available; background work may be cut short on Vercel:', error.message);
    vercelWaitUntil = null;
  }
  return vercelWaitUntil;
}

/** Vercel sets VERCEL=1 in every deployment, preview and production alike. */
function onVercel(env = process.env) {
  return !!(env && env.VERCEL);
}

/**
 * Runs `work` without holding up the response, and on Vercel keeps the
 * function alive until it has finished.
 *
 * @param {Promise|Function} work  a promise already under way, or a function returning one (called now)
 * @param {string} [label]         what the work is, for the log
 * @returns {Promise<*>}  settles when the work does: its result, or undefined when it failed. Never rejects.
 */
function afterResponse(work, label = 'background work') {
  let started;
  try {
    started = Promise.resolve(typeof work === 'function' ? work() : work);
  } catch (error) {
    started = Promise.reject(error);
  }

  const settled = started.catch((error) => {
    console.error(`[after-response] ${label} failed:`, (error && error.message) || error);
    return undefined;
  });

  if (onVercel()) {
    const waitUntil = waitUntilFn();
    if (waitUntil) {
      try {
        waitUntil(settled);
      } catch (error) {
        console.error(`[after-response] could not keep the function alive for ${label}:`, error.message);
      }
    }
  }

  return settled;
}

module.exports = { afterResponse, onVercel };
