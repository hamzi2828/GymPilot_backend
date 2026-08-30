// src/middleware/rateLimit.js
//
// Request ceilings for the endpoints where guessing is the attack: sign-in,
// and the password-reset flow that can be used both to guess and to spam
// somebody's inbox.
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

// Behind Vercel's proxy the socket address is the proxy, so the client is read
// from the forwarded header. express-rate-limit refuses to guess about this,
// hence the explicit resolver rather than trusting `req.ip`.
//
// The address is then passed through ipKeyGenerator, which is what makes the
// limit hold for IPv6. A single IPv6 customer is routinely handed a whole /64
// -- eighteen quintillion addresses -- so keying on the exact address would
// let one attacker take a fresh identity per request and never hit the limit.
// The helper collapses the address to its /64 prefix, which is the unit that
// actually corresponds to one subscriber.
function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw =
    typeof forwarded === 'string' && forwarded.length
      // First entry is the original client; the rest are proxies it passed
      // through.
      ? forwarded.split(',')[0].trim()
      : req.ip || req.socket?.remoteAddress || '';

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

/**
 * Sign-in. Counts only failures, so somebody legitimately signing in and out
 * all day at the front desk is never locked out by their own success.
 */
const loginLimiter = rateLimit({
  ...SHARED,
  windowMs: 15 * 60 * 1000,
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
  windowMs: 60 * 60 * 1000,
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
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many attempts. Please request a fresh reset link.'
});

/**
 * Account creation from the public sign-up form.
 */
const signupLimiter = rateLimit({
  ...SHARED,
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many accounts created from this address. Please try again later.'
});

/**
 * The front-desk app's sign-in. Its own limiter with more headroom: a gym may
 * have several desks behind one office IP address, and locking all of them out
 * because one receptionist fumbled a password would stop the counter working.
 */
const desktopLoginLimiter = rateLimit({
  ...SHARED,
  windowMs: 15 * 60 * 1000,
  max: 40,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts from this location. Please wait a few minutes.'
});

module.exports = {
  loginLimiter,
  passwordResetLimiter,
  passwordResetConfirmLimiter,
  signupLimiter,
  desktopLoginLimiter
};
