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

/** Drops the cached state for every account of the gym in context (a restore). */
function forgetGymSessions() {
  const prefix = `${tenantKey()}:`;
  for (const key of sessions.keys()) if (key.startsWith(prefix)) sessions.delete(key);
}

/**
 * Why this decoded token may no longer be used, or null when it may.
 * Tokens issued before `tv` existed count as version 0. A token that names
 * no account is nobody's session: there is nothing to check it against, so
 * it is refused rather than waved through.
 */
async function sessionProblem(decoded) {
  if (!decoded || !decoded.id) return 'Invalid or expired token';
  const state = await sessionState(decoded.id);
  if (!state.exists) return 'Account no longer exists';
  if (!state.isActive) return 'This account has been deactivated.';
  if ((decoded.tv || 0) !== state.tokenVersion) return 'Your session has ended. Please sign in again.';
  return null;
}

// A gym token carries the id of the gym that issued it (`tid`). It is checked
// against the gym the request resolved to, so a token from one gym's site
// presented on another's is refused even though both verify with the same
// secret. Every sign-in has written the claim for longer than any token
// lives, so one without it is no longer "from before": it belongs to no gym
// and is refused wherever there is a gym to belong to.
function tenantMismatch(decoded, req) {
  if (!decoded || !req.tenant) return false;
  if (!decoded.tid) return true;
  return String(decoded.tid) !== String(req.tenant._id);
}

// What every gym session's token carries: the account and the gym.
function hasSessionClaims(decoded) {
  return !!(decoded && decoded.id && decoded.tid);
}

// Tokens the member app is issued carry `app: 'member'` (see
// controller/mobileAuthController.js). Sign-in checks that the gym has the
// member-app add-on, but a phone keeps its token for 30 days, so the check
// is repeated here -- at most once a minute per gym -- and a gym that has
// lost the add-on gets the same 403 the sign-in gives. Website and desktop
// tokens carry no `app` claim and never reach this.
const MEMBER_APP_CLAIM = 'member';
const MEMBER_APP_TTL_MS = 60 * 1000;
const memberApp = new Map(); // gym id -> { at, enabled }
const MEMBER_APP_NOT_INCLUDED = {
  success: false,
  code: 'MEMBER_APP_NOT_INCLUDED',
  message: 'Your gym has not enabled the member app yet.'
};

async function memberAppEnabled(gym) {
  const key = String(gym._id);
  const hit = memberApp.get(key);
  if (hit && Date.now() - hit.at < MEMBER_APP_TTL_MS) return hit.enabled;

  let enabled = true;
  try {
    const { gymHasAddon } = require('../platform/entitlements');
    if (typeof gymHasAddon === 'function') enabled = !!(await gymHasAddon(gym, 'member-app'));
  } catch (error) {
    // Not knowing is no reason to lock a gym's members out -- and an error
    // thrown from here would reach the catch below and sign them out.
    console.warn('[auth] member-app check failed; allowing it for now:', error.message);
  }

  if (memberApp.size >= MAX_SESSIONS) memberApp.delete(memberApp.keys().next().value);
  memberApp.set(key, { at: Date.now(), enabled });
  return enabled;
}

/**
 * The refusal for a member-app token at a gym without the add-on, or null
 * when the request may go on. Any other token is always null. Never throws.
 */
async function memberAppRefusal(decoded, req) {
  if (!decoded || decoded.app !== MEMBER_APP_CLAIM || !req || !req.tenant) return null;
  return (await memberAppEnabled(req.tenant)) ? null : MEMBER_APP_NOT_INCLUDED;
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
//
// And one 403 that keeps the session: MEMBER_APP_NOT_INCLUDED, for a member
// app token at a gym that no longer has the app (see memberAppRefusal).
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
    // Signed with the right secret but naming no account or no gym: not a
    // session any sign-in here issues.
    if (!hasSessionClaims(decoded)) {
      return res.status(401).json({ message: 'Invalid or expired token', code: 'TOKEN_INVALID' });
    }
    if (tenantMismatch(decoded, req)) {
      return res.status(401).json({ message: 'This session belongs to a different gym. Please sign in again.', code: 'TOKEN_WRONG_GYM' });
    }

    const problem = await sessionProblem(decoded);
    if (problem) return res.status(401).json({ message: problem, code: 'SESSION_ENDED' });

    const refusal = await memberAppRefusal(decoded, req);
    if (refusal) return res.status(403).json(refusal);

    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token', code: 'TOKEN_INVALID' });
  }
};

module.exports.tenantMismatch = tenantMismatch;
module.exports.sessionProblem = sessionProblem;
module.exports.forgetSession = forgetSession;
module.exports.forgetGymSessions = forgetGymSessions;
module.exports.memberAppRefusal = memberAppRefusal;
module.exports.MEMBER_APP_CLAIM = MEMBER_APP_CLAIM;
