// src/platform/controllers/platformAuthController.js

const bcrypt = require('bcryptjs');
const SuperAdmin = require('../models/superAdminModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const { signPlatformToken, ensureBootstrapSuperAdmin } = require('../middleware/platformAuth');

const MIN_PASSWORD_LENGTH = 10;

function publicAdmin(admin) {
  return {
    id: String(admin._id),
    name: admin.name || '',
    email: admin.email,
    last_login: admin.lastLogin || null
  };
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
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

      admin.lastLogin = new Date();
      await admin.save();

      PlatformAuditLog.record({ actorId: admin._id, actorEmail: admin.email, action: 'login', ip: clientIp(req) });

      return res.json({ success: true, token: signPlatformToken(admin), admin: publicAdmin(admin) });
    } catch (error) {
      console.error('[platform] login failed:', error);
      return res.status(500).json({ success: false, message: 'Sign in failed' });
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
