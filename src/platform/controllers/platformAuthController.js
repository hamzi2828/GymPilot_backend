// src/platform/controllers/platformAuthController.js
//
// Signing in to the platform panel, with an optional emailed second step,
// and the forgotten-password flow. Platform email goes through the
// environment's SMTP settings: there is no gym in context here.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const SuperAdmin = require('../models/superAdminModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const { signPlatformToken, ensureBootstrapSuperAdmin } = require('../middleware/platformAuth');
const { sendEmail } = require('../../services/emailService');
const { shell, paragraph, button, escapeHtml } = require('../../templates/gymEmails');

const MIN_PASSWORD_LENGTH = 10;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESET_TTL_MS = 60 * 60 * 1000;
const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymPilot';

function publicAdmin(admin) {
  return {
    id: String(admin._id),
    name: admin.name || '',
    email: admin.email,
    last_login: admin.lastLogin || null,
    two_factor: !!(admin.twoFactor && admin.twoFactor.enabled)
  };
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
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
 * Where the panel lives, for links in email. Never taken from a raw
 * Origin header unless that origin is one the platform already trusts --
 * a reset link pointing at an attacker's domain would hand them the token.
 */
async function panelOrigin(req) {
  if (process.env.PLATFORM_ADMIN_ORIGIN) return process.env.PLATFORM_ADMIN_ORIGIN.replace(/\/+$/, '');
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (origin) {
    const trusted = new Set([process.env.FRONTEND_ORIGIN, process.env.GYMFOLIO_URL].filter(Boolean).map((o) => o.replace(/\/+$/, '')));
    if (trusted.has(origin)) return origin;
    try {
      const { isRegisteredOrigin } = require('../middleware/resolveTenant');
      if (await isRegisteredOrigin(origin)) return origin;
    } catch {
      /* fall through */
    }
  }
  return (process.env.FRONTEND_ORIGIN || 'http://localhost:3000').replace(/\/+$/, '');
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
  const result = await sendEmail(admin.email, `${code} is your ${PLATFORM_NAME} platform sign-in code`, shell(PLATFORM_NAME, 'Your sign-in code', body));
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
      if (!admin || !admin.isActive || !(await bcrypt.compare(password, admin.password))) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      if (admin.twoFactor && admin.twoFactor.enabled) {
        const challenge = await startChallenge(admin);
        if (!challenge.emailed) {
          return res.status(503).json({ success: false, message: 'Could not email your sign-in code. Check the platform SMTP settings.', error: challenge.error });
        }
        return res.json({ success: true, requires2fa: true, challengeId: challenge.challengeId, message: `We emailed a 6-digit code to ${maskEmail(admin.email)}.` });
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
      if (!challengeId || clean.length !== 6) return res.status(400).json({ success: false, message: 'Enter the 6-digit code from your email' });

      const admin = await SuperAdmin.findOne({ 'twoFactor.pending.challengeId': String(challengeId) }).select('+twoFactor.pending.codeHash');
      const pending = admin && admin.twoFactor && admin.twoFactor.pending;
      if (!admin || !pending || !pending.codeHash) return res.status(401).json({ success: false, message: 'This sign-in has expired. Please sign in again.' });

      const expired = !pending.expiresAt || new Date(pending.expiresAt) < new Date();
      const matches = crypto.timingSafeEqual(Buffer.from(pending.codeHash), Buffer.from(hashCode(challengeId, clean)));
      if (expired || !matches) {
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
      PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'login', ip: clientIp(req), meta: { twoFactor: true } });

      return res.json({ success: true, token: signPlatformToken(admin), admin: publicAdmin(admin) });
    } catch (error) {
      console.error('[platform] 2fa failed:', error);
      return res.status(500).json({ success: false, message: 'Could not verify the code' });
    }
  },

  // PUT /api/platform/auth/two-factor   { enabled }
  setTwoFactor: async (req, res) => {
    try {
      const enabled = !!(req.body && (req.body.enabled === true || req.body.enabled === 'true'));
      if (enabled) {
        const { verifyConnection } = require('../../services/emailService');
        const smtp = await verifyConnection();
        if (!smtp.ok) return res.status(409).json({ success: false, message: `Platform email is not working (${smtp.error}); two-factor sign-in cannot be switched on.` });
      }
      const admin = await SuperAdmin.findById(req.superAdmin._id);
      admin.twoFactor = admin.twoFactor || {};
      admin.twoFactor.enabled = enabled;
      await admin.save();
      PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: enabled ? 'two_factor_enabled' : 'two_factor_disabled', ip: clientIp(req) });
      return res.json({ success: true, admin: publicAdmin(admin) });
    } catch (error) {
      console.error('[platform] set 2fa failed:', error);
      return res.status(500).json({ success: false, message: 'Could not update two-factor settings' });
    }
  },

  // POST /api/platform/auth/forgot-password   { email }
  forgotPassword: async (req, res) => {
    const reply = { success: true, message: 'If that address belongs to a platform account, a reset link is on its way.' };
    try {
      const email = String((req.body && req.body.email) || '').toLowerCase().trim();
      if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

      const admin = await SuperAdmin.findOne({ email });
      if (!admin || !admin.isActive) return res.json(reply);

      const token = crypto.randomBytes(32).toString('hex');
      admin.passwordReset = { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) };
      await admin.save();

      const url = `${await panelOrigin(req)}/reset?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
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
        return res.status(401).json({ success: false, message: 'Current password is incorrect' });
      }

      admin.password = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
      await admin.save();

      PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'password_changed', ip: clientIp(req) });

      return res.json({ success: true, message: 'Password updated' });
    } catch (error) {
      console.error('[platform] change password failed:', error);
      return res.status(500).json({ success: false, message: 'Could not update password' });
    }
  }
};
