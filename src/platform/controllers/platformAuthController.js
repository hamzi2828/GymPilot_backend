// src/platform/controllers/platformAuthController.js
//
// Signing in to the platform panel, with an optional second step -- a code
// emailed each time, or one from an authenticator app
// (platformTwoFactorController.js) -- and the forgotten-password flow. Platform email goes through the
// environment's SMTP settings: there is no gym in context here.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const SuperAdmin = require('../models/superAdminModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const { signPlatformToken, ensureBootstrapSuperAdmin, tokenVersionOf } = require('../middleware/platformAuth');
const { sendEmail } = require('../../services/emailService');
const { passwordMatches } = require('../../services/passwordCheck');
const { shell, paragraph, button, escapeHtml } = require('../../templates/gymEmails');
const { localFallback } = require('../tenantContext');
const { platformEmailConfigured } = require('../services/platformEmail');
const twoFactorApp = require('./platformTwoFactorController');

const MIN_PASSWORD_LENGTH = 10;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESET_TTL_MS = 60 * 60 * 1000;
const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymsPilotPro';

function publicAdmin(admin) {
  return {
    id: String(admin._id),
    name: admin.name || '',
    email: admin.email,
    last_login: admin.lastLogin || null,
    two_factor: !!(admin.twoFactor && admin.twoFactor.enabled),
    // 'email' or 'app' while two_factor is on; null when it is off.
    two_factor_method: admin.twoFactor && admin.twoFactor.enabled ? (admin.twoFactor.method === 'totp' ? 'app' : 'email') : null,
    backup_codes_left: twoFactorApp.usesApp(admin) ? Number(admin.twoFactor.totp && admin.twoFactor.totp.backupCodesRemaining) || 0 : null
  };
}

// req.ip, which express takes from the hop Vercel's proxy wrote (index.js
// trusts exactly one), never the first X-Forwarded-For entry: the caller
// writes that one, and could put anyone's address in the audit log.
function clientIp(req) {
  return String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || '');
}

function hashCode(challengeId, code) {
  return crypto.createHash('sha256').update(`${challengeId}:${code}`).digest('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return email;
  const shown = name.length <= 2 ? name[0] || '' : name.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(1, name.length - shown.length))}@${domain}`;
}

/**
 * Where the panel lives, for links in email: what PLATFORM_ADMIN_ORIGIN
 * says, and nothing else. Never the request's Origin header, however
 * trusted that origin is for other things -- a gym's own domain is a
 * registered origin, and a reset link built on it would hand the super
 * admin's token to whoever runs that site. When the variable is not set, a
 * developer's machine gets the panel's local address and production gets
 * null: no link is better than one that points somewhere else.
 */
function panelOrigin(env = process.env) {
  // May be a comma-separated list (www and apex, for CORS); the first entry
  // is the one links point at.
  const first = String(env.PLATFORM_ADMIN_ORIGIN || '').split(',')[0].trim().replace(/\/+$/, '');
  return /^https?:\/\/\S+$/i.test(first) ? first : localFallback('http://localhost:3001', env);
}

async function startChallenge(admin) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const challengeId = crypto.randomBytes(16).toString('hex');
  admin.twoFactor = admin.twoFactor || {};
  admin.twoFactor.pending = { challengeId, codeHash: hashCode(challengeId, code), expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0 };
  await admin.save();

  const body = [
    paragraph(`Hi ${escapeHtml(admin.name || 'there')}, here is your platform sign-in code:`),
    `<p style="margin:0 0 16px;font-size:32px;letter-spacing:0.3em;font-weight:700;color:#18181b">${code}</p>`,
    paragraph('It expires in 10 minutes. If you did not try to sign in, ignore this email.')
  ].join('');
  // The code is in the body only: subjects are written to the mail log
  // (services/emailService.js), and shown by every notification on a phone.
  const result = await sendEmail(admin.email, `Your ${PLATFORM_NAME} platform sign-in code`, shell(PLATFORM_NAME, 'Your sign-in code', body));
  return { challengeId, emailed: !!result.success, error: result.success ? null : result.error };
}

module.exports = {
  // POST /api/platform/auth/login
  login: async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required' });
      }

      await ensureBootstrapSuperAdmin();

      const admin = await SuperAdmin.findOne({ email: String(email).toLowerCase().trim() }).select('+password');
      // bcrypt runs whether or not the address has an account, so the time
      // taken does not say which do (services/passwordCheck.js).
      const matches = await passwordMatches(password, admin && admin.password);
      if (!admin || !admin.isActive || !matches) {
        // For the owner to see who has been trying; never shown to the caller.
        PlatformAuditLog.record({
          actorId: admin ? admin._id : null,
          actorEmail: String(email).toLowerCase().trim().slice(0, 200),
          action: 'login_failed',
          ip: clientIp(req),
          meta: { reason: !admin ? 'unknown_account' : !admin.isActive ? 'inactive' : 'wrong_password' }
        });
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      if (twoFactorApp.usesApp(admin)) {
        // Nothing to send: the code is on the admin's phone.
        const challengeId = crypto.randomBytes(16).toString('hex');
        admin.twoFactor.pending = { challengeId, codeHash: null, expiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0 };
        await admin.save();
        return res.json({ success: true, requires2fa: true, method: 'app', challengeId, message: 'Enter the 6-digit code from your authenticator app, or one of your backup codes.' });
      }

      if (admin.twoFactor && admin.twoFactor.enabled) {
        const challenge = await startChallenge(admin);
        if (!challenge.emailed) {
          return res.status(503).json({ success: false, message: 'Could not email your sign-in code. Check the platform SMTP settings.', error: challenge.error });
        }
        return res.json({ success: true, requires2fa: true, method: 'email', challengeId: challenge.challengeId, message: `We emailed a 6-digit code to ${maskEmail(admin.email)}.` });
      }

      admin.lastLogin = new Date();
      await admin.save();
      PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'login', ip: clientIp(req) });

      return res.json({ success: true, token: signPlatformToken(admin), admin: publicAdmin(admin) });
    } catch (error) {
      console.error('[platform] login failed:', error);
      return res.status(500).json({ success: false, message: 'Sign in failed' });
    }
  },

  // POST /api/platform/auth/login/2fa   { challengeId, code }
  verifyTwoFactor: async (req, res) => {
    try {
      const { challengeId, code } = req.body || {};
      const clean = String(code || '').replace(/\D/g, '');
      if (!challengeId || !code) return res.status(400).json({ success: false, message: 'Enter the 6-digit code' });

      const admin = await SuperAdmin.findOne({ 'twoFactor.pending.challengeId': String(challengeId) }).select(`+twoFactor.pending.codeHash ${twoFactorApp.SECRET_FIELDS}`);
      const pending = admin && admin.twoFactor && admin.twoFactor.pending;
      // An app challenge carries no code of its own; an emailed one must.
      const app = twoFactorApp.usesApp(admin);
      if (!admin || !pending || !pending.challengeId || (!app && !pending.codeHash)) {
        return res.status(401).json({ success: false, message: 'This sign-in has expired. Please sign in again.' });
      }
      if (!app && clean.length !== 6) return res.status(400).json({ success: false, message: 'Enter the 6-digit code from your email' });

      const expired = !pending.expiresAt || new Date(pending.expiresAt) < new Date();
      let check = null;
      let matches = false;
      if (app) {
        // An app code or a backup code, its wrong guesses counted against
        // the account as well as this challenge.
        if (!expired) check = await twoFactorApp.verifyAppCode(admin, code);
        matches = !!(check && check.ok);
      } else {
        matches = crypto.timingSafeEqual(Buffer.from(pending.codeHash), Buffer.from(hashCode(challengeId, clean)));
      }
      if (expired || !matches) {
        if (!expired) {
          PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'login_failed', ip: clientIp(req), meta: { reason: 'wrong_code', method: app ? 'app' : 'email' } });
        }
        if (check && check.locked) {
          admin.twoFactor.pending = null;
          await admin.save();
          return res.status(429).json({ success: false, message: check.message });
        }
        if (expired || pending.attempts + 1 >= MAX_ATTEMPTS) {
          admin.twoFactor.pending = null;
          await admin.save();
          return res.status(401).json({ success: false, message: expired ? 'That code has expired. Please sign in again.' : 'Too many wrong codes. Please sign in again.' });
        }
        admin.twoFactor.pending.attempts = (pending.attempts || 0) + 1;
        await admin.save();
        return res.status(401).json({ success: false, message: `That code is not right. ${MAX_ATTEMPTS - admin.twoFactor.pending.attempts} attempt(s) left.` });
      }

      admin.twoFactor.pending = null;
      admin.lastLogin = new Date();
      await admin.save();
      PlatformAuditLog.record({
        actorId: admin._id,
        actorEmail: admin.email,
        action: 'login',
        ip: clientIp(req),
        meta: { twoFactor: true, method: app ? 'app' : 'email', ...(check && check.backupCode ? { backupCode: true, backupCodesLeft: check.remaining } : {}) }
      });

      return res.json({ success: true, token: signPlatformToken(admin), admin: publicAdmin(admin) });
    } catch (error) {
      console.error('[platform] 2fa failed:', error);
      return res.status(500).json({ success: false, message: 'Could not verify the code' });
    }
  },

  // PUT /api/platform/auth/two-factor   { enabled, currentPassword }
  //
  // Either way the current password is needed: 400 PASSWORD_REQUIRED or
  // PASSWORD_INCORRECT without it (platformTwoFactorController.passwordRefusal).
  setTwoFactor: async (req, res) => {
    try {
      const enabled = !!(req.body && (req.body.enabled === true || req.body.enabled === 'true'));
      // The app is turned off only with the password and a code
      // (two-factor/app/disable), never by this switch.
      if (twoFactorApp.usesApp(req.superAdmin)) {
        return res.status(409).json({ success: false, code: 'APP_TWO_FACTOR', message: 'Sign-in uses your authenticator app. Turn that off first (it needs your password and a code).' });
      }
      const admin = await SuperAdmin.findById(req.superAdmin._id).select('+password');
      if (!admin) return res.status(404).json({ success: false, message: 'Account not found' });
      const toDo = enabled ? 'turn on two-factor sign-in' : 'turn off two-factor sign-in';
      if (await twoFactorApp.refusedWithoutPassword(req, res, admin, req.body && req.body.currentPassword, toDo, 'email')) return;
      if (enabled) {
        const { verifyConnection } = require('../../services/emailService');
        const smtp = await verifyConnection();
        if (!smtp.ok) return res.status(409).json({ success: false, message: `Platform email is not working (${smtp.error}); two-factor sign-in cannot be switched on.` });
      }
      admin.twoFactor = admin.twoFactor || {};
      admin.twoFactor.enabled = enabled;
      admin.twoFactor.method = 'email';
      await admin.save();
      PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: enabled ? 'two_factor_enabled' : 'two_factor_disabled', ip: clientIp(req), meta: { method: 'email' } });
      return res.json({ success: true, admin: publicAdmin(admin) });
    } catch (error) {
      console.error('[platform] set 2fa failed:', error);
      return res.status(500).json({ success: false, message: 'Could not update two-factor settings' });
    }
  },

  // POST /api/platform/auth/forgot-password   { email }
  //
  // 503 before any account is looked up when no link could be sent to
  // anyone: no PLATFORM_ADMIN_ORIGIN to build it on, or no platform mail
  // server to send it with (`code` EMAIL_NOT_CONFIGURED). Otherwise the same
  // answer whether or not the address has an account.
  forgotPassword: async (req, res) => {
    const reply = { success: true, message: 'If that address belongs to a platform account, a reset link is on its way.' };
    try {
      const email = String((req.body && req.body.email) || '').toLowerCase().trim();
      if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

      // Said before any account is looked up, and the same whoever asks: it
      // is about this server, not about the address typed.
      const origin = panelOrigin();
      if (!origin) {
        console.error('[platform] PLATFORM_ADMIN_ORIGIN is not set, so no password reset link can be sent');
        return res.status(503).json({ success: false, message: 'Password reset by email is not set up on this server yet. Ask whoever runs it to set PLATFORM_ADMIN_ORIGIN.' });
      }
      // Promising a link that no mail server will carry leaves the admin
      // waiting for nothing.
      if (!platformEmailConfigured()) {
        console.error('[platform] SMTP_HOST, SMTP_USER and SMTP_PASS are not all set, so no password reset link can be sent');
        return res.status(503).json({
          success: false,
          code: 'EMAIL_NOT_CONFIGURED',
          message: 'Password reset by email is not set up on this server yet: it has no mail server to send from. Ask whoever runs it to set SMTP_HOST, SMTP_USER and SMTP_PASS.'
        });
      }

      const admin = await SuperAdmin.findOne({ email });
      if (!admin || !admin.isActive) return res.json(reply);

      const token = crypto.randomBytes(32).toString('hex');
      admin.passwordReset = { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) };
      await admin.save();

      const url = `${origin}/reset?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
      const body = [
        paragraph(`Hi ${escapeHtml(admin.name || 'there')}, someone asked to reset the password for your ${PLATFORM_NAME} platform account.`),
        button(url, 'Choose a new password'),
        paragraph('The link works for one hour. If you did not ask for this, ignore this email — your password will not change.')
      ].join('');
      await sendEmail(admin.email, `Reset your ${PLATFORM_NAME} platform password`, shell(PLATFORM_NAME, 'Password reset', body));
      PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'password_reset_requested', ip: clientIp(req) });
      return res.json(reply);
    } catch (error) {
      console.error('[platform] forgot password failed:', error);
      return res.json(reply);
    }
  },

  // POST /api/platform/auth/reset-password   { email, token, password }
  resetPassword: async (req, res) => {
    try {
      const { email, token, password } = req.body || {};
      if (!email || !token || !password) return res.status(400).json({ success: false, message: 'Email, token and a new password are required' });
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ success: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }

      const admin = await SuperAdmin.findOne({ email: String(email).toLowerCase().trim() }).select('+passwordReset.tokenHash +password');
      const reset = admin && admin.passwordReset;
      if (!admin || !reset || !reset.tokenHash || !reset.expiresAt || new Date(reset.expiresAt) < new Date()) {
        return res.status(400).json({ success: false, message: 'This reset link is invalid or has expired. Request a new one.' });
      }
      const a = Buffer.from(reset.tokenHash);
      const b = Buffer.from(hashToken(token));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ success: false, message: 'This reset link is invalid or has expired. Request a new one.' });
      }

      admin.password = await bcrypt.hash(password, await bcrypt.genSalt(10));
      admin.passwordReset = { tokenHash: null, expiresAt: null };
      admin.twoFactor = admin.twoFactor || {};
      admin.twoFactor.pending = null;
      // Whoever was signed in with the old password is not any more.
      admin.tokenVersion = tokenVersionOf(admin) + 1;
      await admin.save();
      PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'password_reset', ip: clientIp(req) });

      return res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
    } catch (error) {
      console.error('[platform] reset password failed:', error);
      return res.status(500).json({ success: false, message: 'Could not reset the password' });
    }
  },

  // GET /api/platform/auth/me
  me: async (req, res) => {
    return res.json({ success: true, admin: publicAdmin(req.superAdmin) });
  },

  // PUT /api/platform/auth/password
  changePassword: async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'Current and new password are required' });
      }
      if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ success: false, message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }

      const admin = await SuperAdmin.findById(req.superAdmin._id).select('+password');
      if (!admin || !(await bcrypt.compare(currentPassword, admin.password))) {
        // 400, not 401: the session is fine, it is the form that is wrong.
        // The panel treats a 401 as "signed out" and would send the admin
        // to the sign-in page for a typo.
        if (admin) PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'password_change_failed', ip: clientIp(req), meta: { reason: 'wrong_password' } });
        return res.status(400).json({ success: false, code: 'WRONG_PASSWORD', message: 'The current password is not right. Nothing was changed.' });
      }

      admin.password = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
      // Every other session ends with the old password. This one carries on
      // with the new token in the answer.
      admin.tokenVersion = tokenVersionOf(admin) + 1;
      await admin.save();

      PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'password_changed', ip: clientIp(req) });

      return res.json({ success: true, message: 'Password updated. Everywhere else you were signed in has been signed out.', token: signPlatformToken(admin) });
    } catch (error) {
      console.error('[platform] change password failed:', error);
      return res.status(500).json({ success: false, message: 'Could not update password' });
    }
  },

  // POST /api/platform/auth/logout
  //
  // Ends the session on the server, not just in the browser: the token (and
  // every other token of this account -- sessions are told apart only by
  // generation) stops working at once. $inc, so two sign-outs racing cannot
  // cancel each other out.
  logout: async (req, res) => {
    try {
      await SuperAdmin.updateOne({ _id: req.superAdmin._id }, { $inc: { tokenVersion: 1 } });
      PlatformAuditLog.record({ actorId: req.superAdmin._id, actorEmail: req.superAdmin.email, action: 'logout', ip: clientIp(req) });
      return res.json({ success: true });
    } catch (error) {
      console.error('[platform] sign out failed:', error);
      return res.status(500).json({ success: false, message: 'Could not sign out' });
    }
  },

  // exported for tests
  panelOrigin,
  // for platformTwoFactorController
  publicAdmin
};
