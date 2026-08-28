// src/middleware/optionalAuth.js
const jwt = require('jsonwebtoken');

/**
 * Optional authentication middleware
 * Populates req.user if valid token is present, but doesn't fail if no token
 */
module.exports = function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!token) {
      // No token - continue without user
      req.user = null;
      return next();
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      req.user = null;
      return next();
    }

    const decoded = jwt.verify(token, secret);
    req.user = decoded;
    return next();
  } catch (err) {
    // Invalid token - continue without user
    req.user = null;
    return next();
  }
};
