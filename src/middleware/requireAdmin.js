// src/middleware/requireAdmin.js
//
// Role gate for admin-only endpoints. `auth` only proves the caller holds a
// valid token — it does not check what that token is allowed to do. Any route
// that can change roles, create privileged accounts or read/write credentials
// must sit behind this as well, otherwise any signed-in member could call it.
//
// Must be mounted AFTER `auth`, which populates req.user from the JWT.

const User = require('../models/user');

module.exports = async function requireAdmin(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Authorization required' });
    }

    // Prefer the live role over the token claim: a token issued before a
    // demotion would otherwise keep admin access until it expired.
    let role = req.user.role;
    if (req.user.id) {
      const user = await User.findById(req.user.id).select('role isActive');
      if (!user) return res.status(401).json({ message: 'Account no longer exists' });
      if (user.isActive === false) return res.status(403).json({ message: 'Account is disabled' });
      role = user.role;
    }

    if (role !== 'admin') {
      return res.status(403).json({ message: 'Administrator access required' });
    }

    return next();
  } catch (error) {
    return res.status(500).json({ message: 'Authorization check failed', error: error.message });
  }
};
