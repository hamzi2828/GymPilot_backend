// src/middleware/rateLimit.js
//
// Request ceilings for the endpoints where guessing or flooding is the
// attack: sign-in, the password-reset flow that can be used both to guess and
// to spam somebody's inbox, and the public forms (contact, newsletter, blog
// views) that a script would otherwise fill with junk.
//
// Two things to know about this in production.
//
// First, the store is in-memory. This backend runs serverless on Vercel, where
// each instance keeps its own counters, so the real ceiling is the limit times
// however many instances are warm. That is a weaker guarantee than a shared
// Redis store would give, but it still turns an unlimited online guessing
// attack into a slow one, and it costs nothing to run. Swap in a shared store
// when there is one to point at.
//
// Second, these limits are sized for a gym, not for a public API. A front desk
// mistyping a password five times in a row is normal; five hundred attempts
// from one address in fifteen minutes is not.

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Every limiter is keyed on `req.ip`. index.js sets `trust proxy` to 1, so
// behind Vercel's proxy express has already taken the client address from the
// LAST hop of X-Forwarded-For -- the one the proxy wrote -- and a caller
// cannot pick their own bucket by sending the header themselves. Reading the
// raw header here would hand that choice straight back to them.
//
// The address is then passed through ipKeyGenerator, which is what makes the
// limit hold for IPv6. A single IPv6 customer is routinely handed a whole /64
// -- eighteen quintillion addresses -- so keying on the exact address would
// let one attacker take a fresh identity per request and never hit the limit.
// The helper collapses the address to the prefix that corresponds to one
// subscriber.
function clientKey(req) {
  const raw = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
  return raw ? ipKeyGenerator(raw) : 'unknown';
}

const SHARED = {
  standardHeaders: true,   // RateLimit-* headers, so a client can back off
  legacyHeaders: false,
  keyGenerator: clientKey,
  // The desktop app and the browser both read `message` off a JSON body; an
  // HTML error page here would surface as an unhelpful parse failure.
  handler: (req, res, next, options) => {
    res.status(options.statusCode).json({
      success: false,
      message: options.message
    });
  }
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Sign-in. Counts only failures, so somebody legitimately signing in and out
 * all day at the front desk is never locked out by their own success.
 */
const loginLimiter = rateLimit({
  ...SHARED,
  windowMs: 15 * MINUTE,
  max: 20,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.'
});

/**
 * Password reset requests. Tighter, and it counts successes too: the thing
 * being limited here is how many emails one address can cause to be sent, and
 * a successful request is exactly what sends one.
 */
const passwordResetLimiter = rateLimit({
  ...SHARED,
  windowMs: HOUR,
  max: 5,
  message: 'Too many password reset requests. Please wait an hour and try again.'
});

/**
 * Consuming a reset token. Separate from the request limiter because this is
 * the endpoint where a token could be guessed, and the token is 32 random
 * bytes -- this exists to make the attempt pointless rather than merely
 * expensive.
 */
const passwordResetConfirmLimiter = rateLimit({
  ...SHARED,
  windowMs: 15 * MINUTE,
  max: 10,
  message: 'Too many attempts. Please request a fresh reset link.'
});

/**
 * Account creation from the public sign-up form.
 */
const signupLimiter = rateLimit({
  ...SHARED,
  windowMs: HOUR,
  max: 10,
  message: 'Too many accounts created from this address. Please try again later.'
});

/**
 * Google sign-in with an ID token. A token is verified with Google on every
 * call, so this is both a guessing surface and a way to burn quota.
 */
const googleLoginLimiter = rateLimit({
  ...SHARED,
  windowMs: 15 * MINUTE,
  max: 20,
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.'
});

/**
 * The front-desk app's sign-in. Its own limiter with more headroom: a gym may
 * have several desks behind one office IP address, and locking all of them out
 * because one receptionist fumbled a password would stop the counter working.
 */
const desktopLoginLimiter = rateLimit({
  ...SHARED,
  windowMs: 15 * MINUTE,
  max: 40,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts from this location. Please wait a few minutes.'
});

/**
 * Demo requests from the public marketing site. One person needs one; a
 * script needs to be stopped before it fills the inbox.
 */
const demoRequestLimiter = rateLimit({
  ...SHARED,
  windowMs: HOUR,
  max: 5,
  message: 'Too many requests from this address. Please try again later or email us directly.'
});

/**
 * The contact form. Every submission lands in the gym's enquiries and may be
 * emailed on; ten an hour is a busy visitor, not a script.
 */
const contactLimiter = rateLimit({
  ...SHARED,
  windowMs: HOUR,
  max: 10,
  message: 'Too many messages from this address. Please try again later.'
});

/**
 * Newsletter subscribe and unsubscribe. Shared between the two so a script
 * cannot flip one address on and off all day.
 */
const newsletterLimiter = rateLimit({
  ...SHARED,
  windowMs: HOUR,
  max: 10,
  message: 'Too many newsletter requests from this address. Please try again later.'
});

/**
 * Blog view counts. Unauthenticated and writes to the database, so it is the
 * cheapest way to inflate a number or to keep a serverless instance busy.
 */
const blogViewLimiter = rateLimit({
  ...SHARED,
  windowMs: HOUR,
  max: 60,
  message: 'Too many requests. Please try again later.'
});

/**
 * Generic ceiling for unauthenticated writes elsewhere (bank-transfer proof,
 * public registrations and the like). Exported for the gymfolio router.
 */
const publicWriteLimiter = rateLimit({
  ...SHARED,
  windowMs: 15 * MINUTE,
  max: 20,
  message: 'Too many requests from this address. Please wait a few minutes and try again.'
});

/**
 * Payment starts and confirmations. Each one talks to Stripe; a loop here
 * costs the gym money and Stripe patience. Exported for the gymfolio router.
 */
const paymentLimiter = rateLimit({
  ...SHARED,
  windowMs: 15 * MINUTE,
  max: 30,
  message: 'Too many payment attempts. Please wait a few minutes and try again.'
});

module.exports = {
  clientKey,
  loginLimiter,
  passwordResetLimiter,
  passwordResetConfirmLimiter,
  signupLimiter,
  googleLoginLimiter,
  desktopLoginLimiter,
  demoRequestLimiter,
  contactLimiter,
  newsletterLimiter,
  blogViewLimiter,
  publicWriteLimiter,
  paymentLimiter
};
