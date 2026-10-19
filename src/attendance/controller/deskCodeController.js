// src/attendance/controller/deskCodeController.js
//
// Checking in with your own phone at the front desk (services/deskCode.js):
//
//   POST /api/desktop/checkin-code   the desk's screen asks for its current code
//   POST /api/attendance/me/checkin  a signed-in phone sends back what it scanned
//
// The punch is the desk's. It is recorded under the desk account that is
// signed in on the screen the code came from, and that PC's name -- exactly
// as if that desk had matched a finger. The phone only says who is standing
// there, by being signed in as them; it never names anybody else.

const User = require('../../models/user');
const DesktopToken = require('../models/desktopTokenModel');
const { createPunchLimiter, deviceContext } = require('../middleware/desktopAuth');
const { recordPunch, readRequestId } = require('../services/punchService');
const {
  issueDeskCode,
  verifyDeskCode,
  VALID_SECONDS,
  REFRESH_AFTER_SECONDS,
  CHECKIN_PATH
} = require('../services/deskCode');
const { punchReply, logPunch } = require('./desktopAppController');
const { tenantKey } = require('../../platform/tenantContext');

const CODE_INVALID = {
  success: false,
  code: 'CODE_INVALID',
  message: "That isn't your gym's check-in code. Scan the code on the screen at the front desk."
};
const CODE_EXPIRED = {
  success: false,
  code: 'CODE_EXPIRED',
  message: 'That code has changed. Scan the screen again.'
};
// The screen that showed the code has been signed out since, or its account
// may no longer run a desk. Nothing a member can fix by scanning again.
const DESK_SIGNED_OUT = {
  success: false,
  code: 'DESK_SIGNED_OUT',
  message: 'The check-in screen is signed out. Ask at the front desk.'
};

// Per account, not per desk: one member's phone scanning in a loop must not
// pause the screen for the queue behind them. Ten a minute is far more than
// anyone checking in needs. Held in memory, so per-instance on a serverless
// deployment -- the same trade the desk's sign-in throttle makes.
const CHECKIN_LIMITS = [{ max: 10, windowMs: 60 * 1000 }];
const checkins = createPunchLimiter(CHECKIN_LIMITS);
setInterval(() => checkins.sweep(), CHECKIN_LIMITS[0].windowMs).unref?.();

function limitCheckins(req, res, next) {
  const verdict = checkins.take(`${tenantKey()}|${req.user && req.user.id}`);
  if (verdict.allowed) return next();

  const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
  res.set('Retry-After', String(seconds));
  return res.status(429).json({
    success: false,
    code: 'CHECKIN_PAUSED',
    message: `Too many check-ins in a short time. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
    retry_after: seconds
  });
}

// The desk as its token remembers it from sign-in: the PC that showed the code.
function deskDevice(token) {
  return {
    deviceLabel: token.deviceLabel || '',
    clientApp: token.clientApp || '',
    osUser: token.osUser || '',
    ip: token.ip || ''
  };
}

module.exports = {
  limitCheckins,

  // POST /api/desktop/checkin-code
  //
  // Asked every REFRESH_AFTER_SECONDS by the Windows desk and the web kiosk
  // alike, without a staff unlock: the code names the desk, nobody's details.
  // Not written to the audit trail -- that would be a row every 20 seconds per
  // screen; the check-ins it leads to are.
  checkinCode: async (req, res) => {
    try {
      const { code, expiresAt } = issueDeskCode(req.desktopToken._id);
      return res.json({
        success: true,
        data: {
          code,
          expires_at: expiresAt.toISOString(),
          valid_seconds: VALID_SECONDS,
          refresh_after_seconds: REFRESH_AFTER_SECONDS,
          checkin_path: CHECKIN_PATH
        }
      });
    } catch (err) {
      console.error('[attendance] checkin-code failed:', err);
      return res.status(500).json({ success: false, message: 'Could not make a check-in code.' });
    }
  },

  // POST /api/attendance/me/checkin   { code, request_id? }
  //
  // `code` is what the phone scanned: the bare code, or the check-in page's
  // address carrying it. The person is the signed-in account -- staff when it
  // is on the staff, a member otherwise -- and the answer is the desk punch's.
  checkIn: async (req, res) => {
    const body = req.body || {};
    try {
      const requestId = readRequestId(body.request_id);
      if (requestId === null) {
        return res.status(400).json({
          success: false,
          message: 'request_id must be 8 to 100 letters, digits, hyphens or underscores (a UUID will do).'
        });
      }

      const scanned = verifyDeskCode(body.code);
      if (!scanned.ok) {
        return scanned.reason === 'expired' ? res.status(410).json(CODE_EXPIRED) : res.status(400).json(CODE_INVALID);
      }

      // The desk that showed it must still be signed in, as an account that
      // may still run one -- the checks desktopAuth makes on every desk request.
      const desk = await DesktopToken.findOne({
        _id: scanned.deskTokenId,
        revokedAt: null,
        expiresAt: { $gt: new Date() }
      }).lean();
      const operator = desk ? await User.findById(desk.userId).select('-password') : null;
      if (!operator || !operator.isActive || !operator.allowAttendanceApp) {
        return res.status(409).json(DESK_SIGNED_OUT);
      }

      const user = await User.findById(req.user.id).select('_id isActive employment.isStaff');
      if (!user || user.isActive === false) {
        return res.status(401).json({ success: false, message: 'Account not found' });
      }
      const personType = user.employment && user.employment.isStaff ? 'staff' : 'member';
      const device = deskDevice(desk);

      const result = await recordPunch({
        personType,
        personId: user._id,
        operator,
        device,
        method: 'desk_code',
        requestId
      });

      logPunch({
        operator,
        device,
        personType,
        personId: user._id,
        method: 'desk_code',
        result,
        // Where the phone was: the desk's own address is already on the row.
        meta: { requestId, phoneIp: deviceContext(req).ip || undefined }
      });

      return res.json(punchReply(result));
    } catch (err) {
      console.error('[attendance] desk-code check-in failed:', err);
      return res.status(500).json({ success: false, message: 'Could not record attendance.' });
    }
  }
};
