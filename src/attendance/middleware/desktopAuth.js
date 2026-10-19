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
const { currentTenantId } = require('../../platform/tenantContext');

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
      message: 'This account is not allowed to register fingerprints or faces.'
    });
  }
  return next();
}

// ---------------------------------------------------------------------------
// The web kiosk
//
// The kiosk (the website's /kiosk page) signs in with a desk account just as
// the Windows app does, but it stands on the PUBLIC side of the counter.
// There members check themselves in with their own phone, by scanning the
// code the kiosk shows (POST /checkin-code, services/deskCode.js) -- nothing
// they do touches the kiosk itself. Finding someone by name, and checking
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

// Guards a route on a kiosk token: there it needs the unlock, every time.
// 423 rather than 401/403: the session is fine, and a kiosk treats those two
// as "sign in again".
function kioskStaffOnly() {
  return function kioskStaffGate(req, res, next) {
    if (!isKioskToken(req.desktopToken)) return next();

    const body = req.body || {};
    if (verifyStaffUnlock(body.staff_unlock, req.desktopToken._id)) return next();

    return res.status(423).json({
      success: false,
      code: 'STAFF_UNLOCK_REQUIRED',
      message: 'Staff unlock needed. Ask at the front desk.'
    });
  };
}

// The biometric side of the desk -- /templates and /face-templates, which
// hand out every enrolled template decrypted, and the enrolment and removal
// routes -- belongs to the Windows app behind the counter, next to the reader
// and the camera. A kiosk stands on the public side, so it is refused
// outright; a staff unlock does not open these. 403: this client may never do
// it, whatever is typed. (The kiosk never calls any of them, so its "403
// means sign in again" is not reached by accident.)
function notOnKiosk(req, res, next) {
  if (!isKioskToken(req.desktopToken)) return next();

  return res.status(403).json({
    success: false,
    code: 'KIOSK_NOT_ALLOWED',
    message: 'The web kiosk cannot use fingerprints or faces. Use the front-desk app for that.'
  });
}

// ---------------------------------------------------------------------------
// Check-in methods that are gone
//
// A member used to check in at a kiosk by showing the QR code from their
// account page (`qr`) or typing their member number (`code`). Both could be
// borrowed -- a screenshot of the QR stayed good for two days, and the
// numbers run in sequence -- and both are replaced by the member scanning the
// desk's own code with their phone.
// A punch still carrying either is refused in words a desk can show, before
// a kiosk is asked for its staff unlock: an old kiosk should hear "replaced",
// not "ask at the front desk".
// ---------------------------------------------------------------------------

function refuseRemovedMethods(req, res, next) {
  const body = req.body || {};
  if (!body.qr && !body.code) return next();
  return res.status(400).json({
    success: false,
    code: 'METHOD_REMOVED',
    message: 'Member QR and member-number check-in have been replaced. Scan the code on the desk screen instead.'
  });
}

// ---------------------------------------------------------------------------
// A sliding-window limiter, for punches that are cheap to repeat: a member's
// phone checking in with the desk's code is capped per account
// (deskCodeController). A refused attempt is not counted, so being refused
// never lengthens the wait. `clock` is injectable for the tests.
//
// Held in memory, so on a serverless deployment it is per-instance -- the
// same trade the sign-in throttle makes (see desktopAppController).
// ---------------------------------------------------------------------------

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

module.exports = {
  desktopAuth,
  requireEnrollPermission,
  deviceContext,
  isKioskToken,
  issueStaffUnlock,
  verifyStaffUnlock,
  kioskStaffOnly,
  notOnKiosk,
  refuseRemovedMethods,
  createPunchLimiter
};
