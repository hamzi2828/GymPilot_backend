// src/attendance/middleware/desktopAuth.js
//
// Authenticates a front-desk PC by its long-lived desktop token (see
// desktopTokenModel.js) rather than the 7-day web JWT.
//
// The app-access permission is re-read from the user document on EVERY
// request, not trusted from the token: revoking `allowAttendanceApp` on the
// website has to stop that PC on its very next punch, not in 30 days when the
// token happens to expire. When the check fails, the account's tokens are
// revoked outright so it cannot simply keep retrying.

const DesktopToken = require('../models/desktopTokenModel');
const User = require('../../models/user');

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

    req.desktopUser = user;
    req.desktopToken = stored;
    req.deviceContext = deviceContext(req);

    // Fire-and-forget: a "when was this PC last seen" timestamp is not worth
    // making every punch wait on a second write.
    DesktopToken.updateOne({ _id: stored._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});

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

module.exports = { desktopAuth, requireEnrollPermission, deviceContext };
