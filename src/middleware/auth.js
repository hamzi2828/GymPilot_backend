// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { tenantKey } = require('../platform/tenantContext');

// The account behind a token is re-read briefly so a revoked session or a
// deactivated account is out within half a minute, without a database round
// trip on every single request. Keyed per gym: the same id can never mean
// two people, but the cache must still never cross databases.
const SESSION_TTL_MS = 30 * 1000;
const sessions = new Map(); // `${tenant}:${userId}` -> { at, tokenVersion, isActive }
const MAX_SESSIONS = 5000;

async function sessionState(userId) {
  const key = `${tenantKey()}:${userId}`;
  const hit = sessions.get(key);
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit;

  const User = require('../models/user');
  const account = await User.findById(userId).select('tokenVersion isActive').lean();
  const state = account
    ? { at: Date.now(), exists: true, tokenVersion: account.tokenVersion || 0, isActive: account.isActive !== false }
    : { at: Date.now(), exists: false, tokenVersion: 0, isActive: false };

  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  sessions.set(key, state);
  return state;
}

/** Drops the cached state for one account, e.g. right after a revocation. */
function forgetSession(userId) {
  sessions.delete(`${tenantKey()}:${userId}`);
}

/**
 * Why this decoded token may no longer be used, or null when it may.
 * Tokens issued before `tv` existed count as version 0.
 */
async function sessionProblem(decoded) {
  if (!decoded || !decoded.id) return null;
  const state = await sessionState(decoded.id);
  if (!state.exists) return 'Account no longer exists';
  if (!state.isActive) return 'This account has been deactivated.';
  if ((decoded.tv || 0) !== state.tokenVersion) return 'Your session has ended. Please sign in again.';
  return null;
}

// A gym token carries the id of the gym that issued it (`tid`). It is checked
// against the gym the request resolved to, so a token from one gym's site
// presented on another's is refused even though both verify with the same
// secret. Tokens minted before this claim existed carry no `tid` and are
// accepted as before; they age out with their 7-day expiry.
function tenantMismatch(decoded, req) {
  if (!decoded || !decoded.tid || !req.tenant) return false;
  return String(decoded.tid) !== String(req.tenant._id);
}

// Every refusal carries a machine-readable `code` beside the message. The
// phone app signs the member out on these four and on nothing else -- a 401
// from a wrong current password, or from a wrong 2FA code, must not end the
// session. The website and the desktop app read only `message`, as before.
//
//   TOKEN_MISSING     no bearer token on the request
//   TOKEN_INVALID     unreadable, expired, or not a gym account's token
//   TOKEN_WRONG_GYM   issued by a different gym than the one asked for
//   SESSION_ENDED     the account was deactivated, deleted, or signed out
//                     everywhere (tokenVersion bumped)
module.exports = async function auth(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({ message: 'Authorization token required', code: 'TOKEN_MISSING' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ message: 'Server misconfiguration: missing JWT secret' });
    }

    const decoded = jwt.verify(token, secret);

    // A platform (super admin) session is a different kind of thing and
    // must never pass as a gym account.
    if (decoded.scope === 'platform') {
      return res.status(401).json({ message: 'Invalid or expired token', code: 'TOKEN_INVALID' });
    }
    if (tenantMismatch(decoded, req)) {
      return res.status(401).json({ message: 'This session belongs to a different gym. Please sign in again.', code: 'TOKEN_WRONG_GYM' });
    }

    const problem = await sessionProblem(decoded);
    if (problem) return res.status(401).json({ message: problem, code: 'SESSION_ENDED' });

    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token', code: 'TOKEN_INVALID' });
  }
};

module.exports.tenantMismatch = tenantMismatch;
module.exports.sessionProblem = sessionProblem;
module.exports.forgetSession = forgetSession;
