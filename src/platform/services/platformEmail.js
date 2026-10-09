// src/platform/services/platformEmail.js
//
// Whether the platform's own email actually works -- not merely whether its
// settings are filled in.
//
// The platform sends through the environment's SMTP settings (SMTP_HOST,
// SMTP_PORT, SMTP_USER, SMTP_PASS: what services/emailService.js falls back
// to when no gym is in context, or the gym has no mail server of its own --
// which a gym made a moment ago never has). A wrong password is three
// non-empty variables too. Self-serve sign-up takes a card and then emails
// the buyer the only way into the gym they paid for, so before anyone is
// sent to pay the mail server is asked: do you accept this connection and
// this login? (nodemailer's verify.)
//
// The answer is kept for a short while, so the public config endpoint and a
// burst of sign-ups ask the server once, not every time.

const nodemailer = require('nodemailer');

// A working mail server answers in a second or two; one that does not answer
// in this long is as good as down for somebody waiting to pay.
const VERIFY_TIMEOUT_MS = 5000;
const OK_TTL_MS = 2 * 60 * 1000;
// Shorter: once the settings are fixed, sign-up comes back within the minute.
const FAILED_TTL_MS = 30 * 1000;

/** The platform's SMTP settings, read the way emailService reads its env fallback. */
function platformSmtpConfig(env = process.env) {
  return {
    // Untrimmed, as emailService sends them: the check must fail when a
    // send would.
    host: env.SMTP_HOST,
    port: parseInt(env.SMTP_PORT, 10) || 587,
    secure: env.SMTP_PORT === '465',
    user: env.SMTP_USER,
    pass: env.SMTP_PASS
  };
}

/** Whether the settings are there at all. Says nothing about whether they work. */
function platformEmailConfigured(env = process.env) {
  return ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].every((key) => String(env[key] || '').trim() !== '');
}

// Replaced by tests; everything else goes through nodemailer.
const mailer = {
  createTransport: (options) => nodemailer.createTransport(options)
};

let cached = null; // { key, at, result }
let pending = null; // { key, promise }

async function ask(cfg) {
  const transport = mailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: VERIFY_TIMEOUT_MS,
    greetingTimeout: VERIFY_TIMEOUT_MS,
    socketTimeout: VERIFY_TIMEOUT_MS
  });
  let timer;
  try {
    // The socket timeouts above cover a server that stops answering; this
    // covers one that answers slowly at every step.
    await Promise.race([
      transport.verify(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the mail server did not answer within ${VERIFY_TIMEOUT_MS / 1000} seconds`)), VERIFY_TIMEOUT_MS + 1000);
      })
    ]);
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    clearTimeout(timer);
    if (typeof transport.close === 'function') transport.close();
  }
}

/**
 * Whether the platform's mail server accepts a connection and login right
 * now. Never throws.
 *
 * @returns {Promise<{ok: boolean, error: string}>}
 */
async function verifyPlatformEmail({ env = process.env, now = Date.now() } = {}) {
  if (!platformEmailConfigured(env)) return { ok: false, error: 'SMTP_HOST, SMTP_USER and SMTP_PASS are not all set' };
  const cfg = platformSmtpConfig(env);
  // Changed settings are a different question: never answered from the cache.
  const key = `${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}|${cfg.pass}`;

  if (cached && cached.key === key && now - cached.at < (cached.result.ok ? OK_TTL_MS : FAILED_TTL_MS)) return cached.result;
  // Everyone who asks while the server is being asked shares the one answer.
  if (pending && pending.key === key) return pending.promise;

  const promise = ask(cfg).then((result) => {
    cached = { key, at: now, result };
    if (!result.ok) console.error('[platform] the platform mail server refused a connection or login:', result.error);
    return result;
  });
  pending = { key, promise };
  try {
    return await promise;
  } finally {
    if (pending && pending.promise === promise) pending = null;
  }
}

/** Forgets the last answer, so the next question is asked afresh. */
function forgetPlatformEmailCheck() {
  cached = null;
  pending = null;
}

module.exports = {
  platformEmailConfigured,
  platformSmtpConfig,
  verifyPlatformEmail,
  forgetPlatformEmailCheck,
  mailer,
  VERIFY_TIMEOUT_MS,
  OK_TTL_MS,
  FAILED_TTL_MS
};
