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

// The body fields each sign-in or reset handler takes the account from, in
// the order it reads them. The limiter must read exactly the same: keyed on
// any other field, a caller could put the real target in the field the
// handler reads and a fresh decoy in the one the limiter reads, and every
// request would land in a new bucket.
const FIELDS = {
  website: ['login', 'email', 'username'], // userController.loginUser
  email: ['email'],                        // platform sign-in; email reset forms
  username: ['username'],                  // the phone app (mobileAuthController)
  challenge: ['challengeId']               // every emailed-code step
};

// The account a request is aimed at, as its handler will read it: the
// first field that holds anything, trimmed and lowercased as every handler
// does, so "Ann@Gym.com " and "ann@gym.com" are one bucket.
function submittedIdentifier(req, fields = FIELDS.website) {
  const body = (req && req.body) || {};
  const field = fields.find((name) => body[name]);
  return field ? String(body[field]).toLowerCase().trim().slice(0, 200) : '';
}

// One bucket per address AND account. A gym's members share one public
// address on the gym Wi-Fi; keyed on the address alone, one member fumbling
// a password locked every member out. The fields are the route's, set by
// perAddressAndAccount below (a key generator is handed only req and res).
function identityKey(req) {
  const fields = (req && req.limitFields) || FIELDS.website;
  return `${clientKey(req)}|${submittedIdentifier(req, fields)}`;
}

// A per-address and a per-account limiter as one middleware, with the
// account read from `fields`. The limiter instances are shared by every
// route of a kind (all the sign-ins, all the reset requests), so a script
// cannot multiply its allowance by spreading over the website, the app and
// the platform panel.
function perAddressAndAccount(perAddress, perAccount, fields) {
  return function limited(req, res, next) {
    req.limitFields = fields;
    perAddress(req, res, (error) => (error ? next(error) : perAccount(req, res, next)));
  };
}

/**
 * Sign-in: the website, the phone app, the platform panel and the 2FA code
 * step. Counts only failures, so somebody legitimately signing in and out
 * all day at the front desk is never locked out by their own success.
 *
 * Twenty failures per address and account, the ceiling that stops a guessing
 * attack on one account; and a looser two hundred per address, which a whole
 * gym's Wi-Fi of members will not reach but a script working through a list
 * of accounts will. One limiter per way of naming the account (FIELDS).
 */
const signInPerAddress = rateLimit({
  ...SHARED,
  windowMs: 15 * MINUTE,
  max: 200,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts from this network. Please wait a few minutes and try again.'
});
const signInPerAccount = rateLimit({
  ...SHARED,
  keyGenerator: identityKey,
  windowMs: 15 * MINUTE,
  max: 20,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.'
});
const loginLimiter = perAddressAndAccount(signInPerAddress, signInPerAccount, FIELDS.website);
const appLoginLimiter = perAddressAndAccount(signInPerAddress, signInPerAccount, FIELDS.username);
const platformLoginLimiter = perAddressAndAccount(signInPerAddress, signInPerAccount, FIELDS.email);
const twoFactorLimiter = perAddressAndAccount(signInPerAddress, signInPerAccount, FIELDS.challenge);

/**
 * Password reset requests. Tighter, and it counts successes too: the thing
 * being limited here is how many emails one address can cause to be sent, and
 * a successful request is exactly what sends one. Five an hour per address
 * and account, thirty per address -- the same split as sign-in, for the same
 * shared-Wi-Fi reason. By email on the website and the platform panel, by
 * username on the phone app.
 */
const resetPerAddress = rateLimit({
  ...SHARED,
  windowMs: HOUR,
  max: 30,
  message: 'Too many password reset requests from this network. Please wait an hour and try again.'
});
const resetPerAccount = rateLimit({
  ...SHARED,
  keyGenerator: identityKey,
  windowMs: HOUR,
  max: 5,
  message: 'Too many password reset requests. Please wait an hour and try again.'
});
const passwordResetLimiter = perAddressAndAccount(resetPerAddress, resetPerAccount, FIELDS.email);
const appPasswordResetLimiter = perAddressAndAccount(resetPerAddress, resetPerAccount, FIELDS.username);

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
  identityKey,
  loginLimiter,
  appLoginLimiter,
  platformLoginLimiter,
  twoFactorLimiter,
  passwordResetLimiter,
  appPasswordResetLimiter,
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
