// src/middleware/requirePermission.js
//
// The route-level half of the permission system. requireAdmin answers "is this
// an administrator"; this answers the question roles actually made possible:
// "may THIS account touch THIS tab, at this depth".
//
//   router.get('/packages',   auth, requirePermission('packages'), ...)
//   router.delete('/packages/:id', auth, requirePermission('packages', 'manage'), ...)
//
// With no level given it derives one from the HTTP method: a GET needs 'view',
// anything that writes needs 'manage'. That default is what makes retrofitting
// an existing route a one-line change without having to re-read the handler.
//
// Must be mounted AFTER `auth`, which puts the JWT on req.user.

const User = require('../models/user');
const AdminAuditLog = require('../models/adminAuditLogModel');
const { can, ADMIN_SLUG } = require('../services/roleService');
const { isTab } = require('../config/permissions');

// Every write that passes the gate is recorded once the response is done.
// A read is not: the trail is about what changed, not what was looked at.
function auditAfter(req, res, tab, slug) {
  const startedAt = Date.now();
  res.on('finish', () => {
    AdminAuditLog.record({
      actorId: req.user && req.user.id,
      actorEmail: (req.user && req.user.email) || '',
      actorRole: slug,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      tab,
      status: res.statusCode,
      body: AdminAuditLog.summariseBody(req.body),
      ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      durationMs: Date.now() - startedAt
    });
  });
}

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

module.exports = function requirePermission(tab, level) {
  if (!isTab(tab)) {
    // A typo here would silently grant nothing to everyone, which looks like a
    // permissions bug for as long as it takes someone to find it. Fail at
    // startup instead.
    throw new Error(`requirePermission: "${tab}" is not a known permission tab`);
  }

  return async function permissionGate(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ message: 'Authorization required' });
      }

      const needed = level || (READ_METHODS.includes(req.method) ? 'view' : 'manage');

      // The live role, not the token's claim: a role changed or revoked after
      // the token was issued must take effect now, not when it expires.
      let slug = req.user.role;
      if (req.user.id) {
        const account = await User.findById(req.user.id).select('role isActive').lean();
        if (!account) return res.status(401).json({ message: 'Account no longer exists' });
        if (account.isActive === false) return res.status(403).json({ message: 'Account is disabled' });
        slug = account.role;
      }

      if (slug !== ADMIN_SLUG && !(await can(slug, tab, needed))) {
        return res.status(403).json({
          message: `Your role does not have ${needed} access to ${tab}.`
        });
      }

      req.permissionTab = tab;
      req.roleSlug = slug;
      if (!READ_METHODS.includes(req.method)) auditAfter(req, res, tab, slug);
      return next();
    } catch (error) {
      return res.status(500).json({ message: 'Permission check failed', error: error.message });
    }
  };
};
