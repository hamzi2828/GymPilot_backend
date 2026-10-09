// src/platform/middleware/platformAuth.js
//
// Authentication for the platform panel. Its own token, its own secret, its
// own accounts: a super admin's session verifies here and nowhere else, and a
// gym administrator's session does not verify here at all.

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const SuperAdmin = require('../models/superAdminModel');

const TOKEN_TTL = process.env.PLATFORM_TOKEN_TTL || '12h';

function platformSecret() {
  if (process.env.PLATFORM_JWT_SECRET) return process.env.PLATFORM_JWT_SECRET;
  // Derived from the gym-side secret so a deployment with one secret set
  // still works, but distinct from it so a gym token can never verify here
  // and a platform token can never verify there.
  return process.env.JWT_SECRET ? `${process.env.JWT_SECRET}::platform` : null;
}

/** The session generation a token was signed under, or an account is on: 0 until it first moves. */
function tokenVersionOf(value) {
  return Number(value && value.tokenVersion) || 0;
}

function signPlatformToken(admin) {
  const secret = platformSecret();
  if (!secret) throw new Error('Server misconfiguration: missing JWT secret');
  return jwt.sign(
    { sid: String(admin._id), email: admin.email, name: admin.name || '', scope: 'platform', tv: tokenVersionOf(admin) },
    secret,
    { expiresIn: TOKEN_TTL }
  );
}

async function platformAuth(req, res, next) {
  try {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Authorization token required' });

    const secret = platformSecret();
    if (!secret) return res.status(500).json({ success: false, message: 'Server misconfiguration: missing JWT secret' });

    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired session' });
    }
    if (decoded.scope !== 'platform' || !decoded.sid) {
      return res.status(401).json({ success: false, message: 'Invalid or expired session' });
    }

    // Re-read on every request so a deactivated super admin is out on their
    // next click, not when the token happens to expire.
    const admin = await SuperAdmin.findById(decoded.sid).lean();
    if (!admin || admin.isActive === false) {
      return res.status(401).json({ success: false, message: 'This account is no longer active' });
    }
    // Signed before the password last changed, or before a sign-out: over,
    // however long the token itself still has to run. A token from before
    // versions existed carries none, which reads as 0 -- good until the
    // account's first change.
    if ((Number(decoded.tv) || 0) !== tokenVersionOf(admin)) {
      return res.status(401).json({ success: false, message: 'This session has ended. Please sign in again.' });
    }

    req.superAdmin = admin;
    return next();
  } catch (error) {
    console.error('[platform] auth failed:', error);
    return res.status(500).json({ success: false, message: 'Authentication failed' });
  }
}

/**
 * Creates the first super admin from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD
 * when the collection is empty. Serverless deployments have no shell to run
 * a script from, so the first sign-in attempt is what bootstraps the account.
 */
async function ensureBootstrapSuperAdmin() {
  const email = String(process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) return null;

  const count = await SuperAdmin.countDocuments({});
  if (count > 0) return null;

  const hashed = await bcrypt.hash(password, await bcrypt.genSalt(10));
  const admin = await SuperAdmin.create({ name: 'Platform Owner', email, password: hashed, isActive: true });
  console.log(`[platform] bootstrapped super admin ${email}`);
  return admin;
}

module.exports = { platformAuth, signPlatformToken, ensureBootstrapSuperAdmin, platformSecret, tokenVersionOf };
