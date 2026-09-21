// src/attendance/middleware/desktopAuth.js
//
// Authenticates a front-desk PC by its long-lived desktop token (see
// desktopTokenModel.js) rather than the 7-day web JWT.
//
// The app-access permission is re-read from the user document on EVERY
// request, not trusted from the token: revoking `allowAttendanceApp` on the
// website has to stop that PC on its very next punch, not whenever the token
// happens to expire. When the check fails, the account's tokens are revoked
// outright so it cannot simply keep retrying.

const crypto = require('crypto');

const DesktopToken = require('../models/desktopTokenModel');
const User = require('../../models/user');
const { tenantKey, currentTenantId } = require('../../platform/tenantContext');

// Both are read straight off the request by the endpoints too, so they live
// here in one place.
function deviceContext(req) {
  const body = req.body || {};
  return {
    deviceLabel: String(body.device_label || '').slice(0, 120),
    clientApp: String(body.client_app || req.headers['user-agent'] || '').slice(0, 120),
    osUser: String(body.client_os_user || '').slice(0, 120),
    ip: String(
      req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''
    ).split(',')[0].trim()
  };
}

async function desktopAuth(req, res, next) {
  try {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Authorization token required' });
    }

    const stored = await DesktopToken.findUsable(token);
    if (!stored) {
      // Expired, revoked, or never existed -- the app treats all three the
      // same way: sign in again.
      return res
        .status(401)
        .json({ success: false, message: 'Your session has expired. Please sign in again.' });
    }

    const user = await User.findById(stored.userId).select('-password');
    if (!user || !user.isActive) {
      await DesktopToken.revokeAllForUser(stored.userId);
      return res
        .status(401)
        .json({ success: false, message: 'Your session has expired. Please sign in again.' });
    }

    if (!user.allowAttendanceApp) {
      // 403, not 401: the token is fine, the permission is gone. The app
      // words these differently at the desk, so the distinction matters.
      await DesktopToken.revokeAllForUser(user._id);
      return res.status(403).json({
        success: false,
        message: 'This account is no longer allowed to use the attendance app.'
      });
    }

    // Sliding renewal (see desktopTokenModel): a desk still in use in its
    // last week is given another full term, so it is not signed out in the
    // middle of a shift. Only reached once every check above has passed, so
    // a revoked account or a withdrawn permission is never renewed.
    const now = new Date();
    const touch = { lastUsedAt: now };
    const renewed = DesktopToken.renewedExpiry(stored, now);
    if (renewed) {
      touch.expiresAt = renewed;
      stored.expiresAt = renewed;
    }

    req.desktopUser = user;
    req.desktopToken = stored;
    req.deviceContext = deviceContext(req);

    // Fire-and-forget: a "when was this PC last seen" timestamp is not worth
    // making every punch wait on a second write. It never touches revokedAt,
    // and skips a token revoked in the meantime, so a sign-out still wins.
    DesktopToken.updateOne({ _id: stored._id, revokedAt: null }, { $set: touch }).catch(() => {});

    return next();
  } catch (err) {
    console.error('[attendance] desktopAuth failed:', err);
    return res.status(500).json({ success: false, message: 'Authentication failed' });
  }
}

// Enrolment is a second, narrower grant on top of app access.
function requireEnrollPermission(req, res, next) {
  if (!req.desktopUser || !req.desktopUser.allowFingerprintEnrollment) {
    return res.status(403).json({
      success: false,
      message: 'This account is not allowed to register fingerprints.'
    });
  }
  return next();
}

// ---------------------------------------------------------------------------
// The web kiosk
//
// The kiosk (the website's /kiosk page) signs in with a desk account just as
// the Windows app does, but it stands on the PUBLIC side of the counter.
// There a member may only check themselves in -- the QR code from their
// account page, or their member number. Finding someone by name, and checking
// them in by hand, are staff actions, so a kiosk token needs a short-lived
// staff unlock for them: the desk account's password typed again (POST
// /unlock), which returns a signed grant the kiosk sends back as
// `staff_unlock` until it locks itself again.
//
// Which tokens are kiosk tokens is settled by what signed in, recorded on the
// token at login -- never by anything a later request says about itself. The
// Windows app sits behind the counter and is never asked.
// ---------------------------------------------------------------------------

const KIOSK_CLIENT = /^GymPilotKiosk\//i;

function isKioskToken(token) {
  return Boolean(token && KIOSK_CLIENT.test(String(token.clientApp || '')));
}

const UNLOCK_VERSION = 'GPU1';

// The server's ceiling on one unlock. The kiosk locks itself far sooner --
// after a minute without a tap -- and forgets the grant when it does; this
// only bounds how long a grant it failed to forget stays good.
const UNLOCK_SECONDS = 10 * 60;

function unlockSecret() {
  const value = process.env.QR_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error('Cannot sign staff unlocks: set QR_TOKEN_SECRET (or JWT_SECRET)');
  return value;
}

// Tied to the gym and to the one desk token it was issued to, so a grant
// cannot be carried to another desk or another gym.
function unlockSignature(tenantId, tokenId, exp) {
  return crypto
    .createHmac('sha256', unlockSecret())
    .update(['staff-unlock', tenantId, tokenId, exp].join('|'))
    .digest('base64url');
}

//   GPU1.<expiry unix seconds>.<signature>
function issueStaffUnlock(tokenId, now = Date.now()) {
  const exp = String(Math.floor(now / 1000) + UNLOCK_SECONDS);
  const sig = unlockSignature(currentTenantId() || '', String(tokenId), exp);
  return { unlock: `${UNLOCK_VERSION}.${exp}.${sig}`, expiresAt: new Date(Number(exp) * 1000), ttlSeconds: UNLOCK_SECONDS };
}

function verifyStaffUnlock(grant, tokenId, now = Date.now()) {
  try {
    const parts = String(grant || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== UNLOCK_VERSION || !/^\d+$/.test(parts[1])) return false;
    if (Number(parts[1]) * 1000 <= now) return false;

    const expected = Buffer.from(unlockSignature(currentTenantId() || '', String(tokenId), parts[1]));
    const given = Buffer.from(parts[2]);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  } catch (err) {
    // No secret configured: nothing can have been issued, so nothing verifies.
    return false;
  }
}

// Guards a route on a kiosk token. `selfService(body)` names the requests a
// member may make on their own there; everything else needs the unlock.
// 423 rather than 401/403: the session is fine, and a kiosk treats those two
// as "sign in again".
function kioskStaffOnly(selfService) {
  return function kioskStaffGate(req, res, next) {
    if (!isKioskToken(req.desktopToken)) return next();

    const body = req.body || {};
    if (selfService && selfService(body)) return next();
    if (verifyStaffUnlock(body.staff_unlock, req.desktopToken._id)) return next();

    return res.status(423).json({
      success: false,
      code: 'STAFF_UNLOCK_REQUIRED',
      message: 'Staff unlock needed. Ask at the front desk.'
    });
  };
}

// The fingerprint side of the desk -- /templates, which hands out every
// enrolled template decrypted, and /enroll, which writes new ones -- belongs
// to the Windows app behind the counter, next to the reader. A kiosk has no
// reader and stands on the public side, so it is refused outright; a staff
// unlock does not open these. 403: this client may never do it, whatever
// is typed. (The kiosk never calls either, so its "403 means sign in again"
// is not reached by accident.)
function notOnKiosk(req, res, next) {
  if (!isKioskToken(req.desktopToken)) return next();

  return res.status(403).json({
    success: false,
    code: 'KIOSK_NOT_ALLOWED',
    message: 'The web kiosk cannot use fingerprints. Use the front-desk app for that.'
  });
}

// A punch a member makes for themselves: a QR code or a typed number. Read
// the way the punch controller reads them -- a qr wins over a code, and
// either one wins over a person_id.
function isSelfServicePunch(body) {
  return Boolean(body.qr || body.code);
}

// ---------------------------------------------------------------------------
// Typed member numbers
//
// Codes are sequential (GP-0001, GP-0002...), so anyone at a kiosk can type a
// number that is not theirs, and every hit puts a name and a package on the
// screen. Code punches are therefore capped per desk token: enough for a
// queue at the door, far too few to walk the member list. Every one of them
// is also a recorded visit, so a run of them shows in the attendance log.
//
// Held in memory, so on a serverless deployment it is per-instance -- the
// same trade the sign-in throttle makes (see desktopAppController).
// ---------------------------------------------------------------------------

const CODE_PUNCH_LIMITS = [
  { max: 12, windowMs: 60 * 1000 }, // a queue at the door, not a script
  { max: 60, windowMs: 10 * 60 * 1000 } // sustained: one every ten seconds
];

// A sliding log per key. A refused attempt is not counted, so being refused
// never lengthens the wait. `clock` is injectable for the tests.
function createPunchLimiter(limits, clock = Date.now) {
  const longest = Math.max(...limits.map((limit) => limit.windowMs));
  const hits = new Map();

  function take(key) {
    const now = clock();
    const log = (hits.get(key) || []).filter((at) => now - at < longest);

    for (const { max, windowMs } of limits) {
      const inWindow = log.filter((at) => now - at < windowMs);
      if (inWindow.length >= max) {
        hits.set(key, log);
        return { allowed: false, retryAfterMs: inWindow[0] + windowMs - now };
      }
    }

    log.push(now);
    hits.set(key, log);
    return { allowed: true, retryAfterMs: 0 };
  }

  function sweep() {
    const now = clock();
    for (const [key, log] of hits) {
      if (!log.length || now - log[log.length - 1] >= longest) hits.delete(key);
    }
  }

  return { take, sweep, size: () => hits.size };
}

const codePunches = createPunchLimiter(CODE_PUNCH_LIMITS);

// Opportunistic sweep so a long-running instance does not keep a log for
// every desk that ever typed a number.
setInterval(() => codePunches.sweep(), CODE_PUNCH_LIMITS[1].windowMs).unref?.();

function waitLabel(seconds) {
  if (seconds < 60) return seconds + ' second' + (seconds === 1 ? '' : 's');
  const minutes = Math.ceil(seconds / 60);
  return minutes + ' minute' + (minutes === 1 ? '' : 's');
}

function limitCodePunches(req, res, next) {
  const body = req.body || {};
  // Only a typed number: a QR code is signed and short-lived, and a
  // fingerprint or a staff pick names the person outright.
  if (body.qr || !body.code) return next();

  const key = tenantKey() + '|' + String(req.desktopToken && req.desktopToken._id);
  const verdict = codePunches.take(key);
  if (verdict.allowed) return next();

  const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
  res.set('Retry-After', String(seconds));
  return res.status(429).json({
    success: false,
    code: 'CODE_ENTRY_PAUSED',
    message:
      `Too many member numbers typed in a short time. Try again in ${waitLabel(seconds)}, ` +
      'or scan the QR code from your account page.',
    retry_after: seconds
  });
}

module.exports = {
  desktopAuth,
  requireEnrollPermission,
  deviceContext,
  isKioskToken,
  issueStaffUnlock,
  verifyStaffUnlock,
  kioskStaffOnly,
  notOnKiosk,
  isSelfServicePunch,
  createPunchLimiter,
  limitCodePunches,
  CODE_PUNCH_LIMITS
};
