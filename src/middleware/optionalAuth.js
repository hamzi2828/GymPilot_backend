// src/middleware/optionalAuth.js
const jwt = require('jsonwebtoken');
const { tenantMismatch, sessionProblem } = require('./auth');

/**
 * Optional authentication middleware
 * Populates req.user if valid token is present, but doesn't fail if no token
 */
module.exports = async function optionalAuth(req, res, next) {
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

    // A platform session, or a token issued by a different gym, counts as no
    // token at all here -- the same as any other token this gym did not issue.
    if (decoded.scope === 'platform' || tenantMismatch(decoded, req) || (await sessionProblem(decoded))) {
      req.user = null;
      return next();
    }

    req.user = decoded;
    return next();
  } catch (err) {
    // Invalid token - continue without user
    req.user = null;
    return next();
  }
};
