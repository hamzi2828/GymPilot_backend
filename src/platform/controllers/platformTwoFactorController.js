// src/platform/controllers/platformTwoFactorController.js
//
// Two-factor sign-in with an authenticator app, for super admins. The
// emailed code (platformAuthController) needs working SMTP; this needs only
// a phone.
//
//   setup   -> the password; then a fresh secret, held as pending, and the
//              otpauth:// URL the panel draws as a QR code. Nothing changes yet.
//   enable  -> the password again and a code from the app, which proves it
//              was scanned; the secret becomes the account's, and ten
//              one-time backup codes are shown once.
//   disable -> password AND a current code (or a backup code).
//
// The secret is sealed at rest with the settings key (services/secretBox.js),
// always outside any gym's scope, as the platform's own Stripe keys are.

const bcrypt = require('bcryptjs');
const SuperAdmin = require('../models/superAdminModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const { seal, open } = require('../../services/secretBox');
const { passwordMatches } = require('../../services/passwordCheck');
const { storage } = require('../tenantContext');
const totp = require('../totp');

const SETUP_TTL_MS = 15 * 60 * 1000;
// Wrong app codes in a row, across sign-ins, before the account waits.
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60 * 1000;
const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymsPilotPro';

// Never under a gym's key: the same secret must open whoever is asking.
const sealSecret = (value) => storage.run(undefined, () => seal(value));
const openSecret = (value) => storage.run(undefined, () => open(value));

// Fields a check reads that are hidden by default.
const SECRET_FIELDS = '+twoFactor.totp.secret +twoFactor.totp.backupCodes';

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

function publicAdmin(admin) {
  // Required here, not at the top: platformAuthController requires this file.
  return require('./platformAuthController').publicAdmin(admin);
}

function usesApp(admin) {
  return !!(admin && admin.twoFactor && admin.twoFactor.enabled && admin.twoFactor.method === 'totp');
}

/**
 * "Type your password to change how you sign in." A session can be taken
 * (a shared computer, a copied token) without the password being known, and
 * without this such a session could switch the emailed codes off, or put its
 * own authenticator app in their place, and keep the account. Every change to
 * the second step asks for it.
 *
 * Resolves to null when `typed` is the account's password, or to the body of
 * the 400 to send -- never a 401, which the panel takes to mean "signed out".
 * The codes are the gym side's (services/passwordCheck.js):
 *
 *   PASSWORD_REQUIRED   none was sent
 *   PASSWORD_INCORRECT  it does not match
 *
 * @param {{ password?: string }} admin  loaded with +password
 */
async function passwordRefusal(admin, typed, toDo) {
  if (!typed || typeof typed !== 'string') {
    return {
      success: false,
      code: 'PASSWORD_REQUIRED',
      message: `Enter your current password to ${toDo}. It stops anyone else who gets into your session from changing how you sign in.`
    };
  }
  if (!(await passwordMatches(typed, admin && admin.password))) {
    return { success: false, code: 'PASSWORD_INCORRECT', message: 'That password is not right, so nothing was changed.' };
  }
  return null;
}

/** Refuses with passwordRefusal's answer, written to the audit log when it was a wrong password. Resolves true when it refused. */
async function refusedWithoutPassword(req, res, admin, typed, toDo, step) {
  const refusal = await passwordRefusal(admin, typed, toDo);
  if (!refusal) return false;
  if (refusal.code === 'PASSWORD_INCORRECT') {
    PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'two_factor_change_failed', ip: clientIp(req), meta: { reason: 'wrong_password', step } });
  }
  res.status(400).json(refusal);
  return true;
}

/**
 * Checks a code typed by an account with the app switched on: a code from
 * the app, or one of its backup codes. `admin` is a document loaded with
 * SECRET_FIELDS. Spent codes are claimed with a conditional update, so two
 * requests racing with one code cannot both get in. Never throws.
 *
 * @returns {Promise<{ ok: boolean, locked?: boolean, backupCode?: boolean, remaining?: number, message?: string }>}
 */
async function verifyAppCode(admin, code) {
  const state = (admin.twoFactor && admin.twoFactor.totp) || {};
  if (state.lockedUntil && new Date(state.lockedUntil) > new Date()) {
    const minutes = Math.ceil((new Date(state.lockedUntil) - Date.now()) / 60000);
    return { ok: false, locked: true, message: `Too many wrong codes. Try again in ${minutes} minute(s).` };
  }

  const secret = openSecret(state.secret);
  const lastStep = Number.isFinite(state.lastStep) ? state.lastStep : -1;
  const step = secret ? totp.verifyTotp(secret, code, { afterStep: lastStep }) : null;
  if (step !== null) {
    const claimed = await SuperAdmin.updateOne(
      { _id: admin._id, 'twoFactor.totp.lastStep': { $lt: step } },
      { $set: { 'twoFactor.totp.lastStep': step, 'twoFactor.totp.failures': 0, 'twoFactor.totp.lockedUntil': null } }
    );
    if (claimed.modifiedCount === 1) {
      admin.twoFactor.totp.lastStep = step;
      admin.twoFactor.totp.failures = 0;
      admin.twoFactor.totp.lockedUntil = null;
      return { ok: true };
    }
  }

  const hashes = state.backupCodes || [];
  const index = totp.matchBackupCode(hashes, code);
  if (index !== -1) {
    const hash = hashes[index];
    const claimed = await SuperAdmin.updateOne(
      { _id: admin._id, 'twoFactor.totp.backupCodes': hash },
      { $pull: { 'twoFactor.totp.backupCodes': hash }, $inc: { 'twoFactor.totp.backupCodesRemaining': -1 }, $set: { 'twoFactor.totp.failures': 0, 'twoFactor.totp.lockedUntil': null } }
    );
    if (claimed.modifiedCount === 1) {
      const fresh = await SuperAdmin.findById(admin._id).select(SECRET_FIELDS).lean();
      const left = (fresh && fresh.twoFactor && fresh.twoFactor.totp && fresh.twoFactor.totp.backupCodes) || [];
      // Kept in step with the database, so a later save() writes the same.
      admin.twoFactor.totp.backupCodes = left;
      admin.twoFactor.totp.backupCodesRemaining = left.length;
      admin.twoFactor.totp.failures = 0;
      admin.twoFactor.totp.lockedUntil = null;
      return { ok: true, backupCode: true, remaining: left.length };
    }
  }

  // Wrong (or already used). Counted on the account, whatever challenge it
  // came in on; $inc so racing guesses all count.
  const after = await SuperAdmin.findOneAndUpdate(
    { _id: admin._id },
    { $inc: { 'twoFactor.totp.failures': 1 } },
    { new: true, projection: { 'twoFactor.totp.failures': 1 } }
  ).lean();
  const failures = (after && after.twoFactor && after.twoFactor.totp && after.twoFactor.totp.failures) || 0;
  admin.twoFactor.totp.failures = failures;
  if (failures >= MAX_FAILURES) {
    const lockedUntil = new Date(Date.now() + LOCK_MS);
    await SuperAdmin.updateOne({ _id: admin._id }, { $set: { 'twoFactor.totp.failures': 0, 'twoFactor.totp.lockedUntil': lockedUntil } });
    admin.twoFactor.totp.failures = 0;
    admin.twoFactor.totp.lockedUntil = lockedUntil;
    return { ok: false, locked: true, message: `Too many wrong codes. Try again in ${Math.round(LOCK_MS / 60000)} minutes.` };
  }
  return { ok: false, message: 'That code is not right.' };
}

module.exports = {
  // POST /api/platform/auth/two-factor/app/setup   { currentPassword }
  setup: async (req, res) => {
    try {
      const admin = await SuperAdmin.findById(req.superAdmin._id).select('+password');
      if (!admin) return res.status(404).json({ success: false, message: 'Account not found' });
      if (usesApp(admin)) {
        return res.status(409).json({ success: false, message: 'An authenticator app is already set up. Turn it off first to set up another.' });
      }
      if (await refusedWithoutPassword(req, res, admin, req.body && req.body.currentPassword, 'set up an authenticator app', 'app_setup')) return;
      const secret = totp.generateSecret();
      admin.twoFactor = admin.twoFactor || {};
      admin.twoFactor.totp = admin.twoFactor.totp || {};
      admin.twoFactor.totp.pendingSecret = sealSecret(secret);
      admin.twoFactor.totp.pendingExpiresAt = new Date(Date.now() + SETUP_TTL_MS);
      await admin.save();
      return res.json({
        success: true,
        data: {
          secret,
          otpauth_url: totp.otpauthUrl({ secret, account: admin.email, issuer: PLATFORM_NAME }),
          issuer: PLATFORM_NAME,
          account: admin.email,
          expires_at: admin.twoFactor.totp.pendingExpiresAt
        }
      });
    } catch (error) {
      console.error('[platform] 2fa app setup failed:', error);
      return res.status(500).json({ success: false, message: 'Could not start setting up the authenticator app' });
    }
  },

  // POST /api/platform/auth/two-factor/app/enable   { code, currentPassword }
  //
  // This is the step that replaces the emailed codes (or no second step)
  // with the app, so the password is asked for here as well as at setup.
  enable: async (req, res) => {
    try {
      const code = String((req.body && req.body.code) || '').replace(/\s/g, '');
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ success: false, message: 'Enter the 6-digit code your app shows' });

      const admin = await SuperAdmin.findById(req.superAdmin._id).select('+twoFactor.totp.pendingSecret +password');
      const state = admin && admin.twoFactor && admin.twoFactor.totp;
      if (!state || !state.pendingSecret || !state.pendingExpiresAt || new Date(state.pendingExpiresAt) < new Date()) {
        return res.status(400).json({ success: false, code: 'SETUP_EXPIRED', message: 'This setup has expired. Start again to get a new QR code.' });
      }
      if (await refusedWithoutPassword(req, res, admin, req.body && req.body.currentPassword, 'turn on the authenticator app', 'app_enable')) return;
      const secret = openSecret(state.pendingSecret);
      const step = secret ? totp.verifyTotp(secret, code) : null;
      if (step === null) {
        // 400, not 401: the session is fine (the panel signs out on a 401).
        return res.status(400).json({ success: false, code: 'WRONG_CODE', message: 'That code is not right. Check the time on your phone is set automatically, then try the newest code.' });
      }

      const backup = totp.generateBackupCodes();
      admin.twoFactor.enabled = true;
      admin.twoFactor.method = 'totp';
      admin.twoFactor.pending = null;
      admin.twoFactor.totp.secret = sealSecret(secret);
      admin.twoFactor.totp.pendingSecret = null;
      admin.twoFactor.totp.pendingExpiresAt = null;
      admin.twoFactor.totp.lastStep = step;
      admin.twoFactor.totp.backupCodes = backup.hashes;
      admin.twoFactor.totp.backupCodesRemaining = backup.hashes.length;
      admin.twoFactor.totp.enabledAt = new Date();
      admin.twoFactor.totp.failures = 0;
      admin.twoFactor.totp.lockedUntil = null;
      await admin.save();
      PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'two_factor_enabled', ip: clientIp(req), meta: { method: 'totp' } });

      return res.json({ success: true, admin: publicAdmin(admin), backup_codes: backup.codes });
    } catch (error) {
      console.error('[platform] 2fa app enable failed:', error);
      return res.status(500).json({ success: false, message: 'Could not turn on the authenticator app' });
    }
  },

  // POST /api/platform/auth/two-factor/app/disable   { password, code }
  disable: async (req, res) => {
    try {
      const { password, code } = req.body || {};
      if (!password || !code) return res.status(400).json({ success: false, message: 'Your password and a code from your app (or a backup code) are required' });

      const admin = await SuperAdmin.findById(req.superAdmin._id).select(`+password ${SECRET_FIELDS}`);
      if (!admin || !usesApp(admin)) return res.status(409).json({ success: false, message: 'The authenticator app is not switched on' });

      if (!(await bcrypt.compare(String(password), admin.password))) {
        PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'two_factor_disable_failed', ip: clientIp(req), meta: { reason: 'wrong_password' } });
        return res.status(400).json({ success: false, code: 'WRONG_PASSWORD', message: 'The password is not right. Nothing was changed.' });
      }
      const check = await verifyAppCode(admin, code);
      if (!check.ok) {
        PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'two_factor_disable_failed', ip: clientIp(req), meta: { reason: check.locked ? 'locked' : 'wrong_code' } });
        return res.status(check.locked ? 429 : 400).json({ success: false, code: 'WRONG_CODE', message: `${check.message} Nothing was changed.` });
      }

      admin.twoFactor.enabled = false;
      admin.twoFactor.method = 'email';
      admin.twoFactor.pending = null;
      admin.twoFactor.totp = { secret: null, pendingSecret: null, pendingExpiresAt: null, lastStep: -1, backupCodes: [], backupCodesRemaining: 0, enabledAt: null, failures: 0, lockedUntil: null };
      await admin.save();
      PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'two_factor_disabled', ip: clientIp(req), meta: { method: 'totp', backupCode: !!check.backupCode } });

      return res.json({ success: true, admin: publicAdmin(admin) });
    } catch (error) {
      console.error('[platform] 2fa app disable failed:', error);
      return res.status(500).json({ success: false, message: 'Could not turn off the authenticator app' });
    }
  },

  verifyAppCode,
  usesApp,
  passwordRefusal,
  refusedWithoutPassword,
  SECRET_FIELDS,
  MAX_FAILURES
};
