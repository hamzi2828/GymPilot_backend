// src/services/adminPasswords.js
//
// Staff setting somebody else's password: a member at the desk with no email
// address, a new receptionist whose invitation never arrived, anyone locked
// out while the gym's outgoing email is down. When the only way a password
// could travel was an email, every one of those people was shut out the
// moment SMTP broke -- the generated password was thrown away with the
// failed send.
//
// What lives here, shared by the Users and Staff screens:
//
//   generatePassword  -- strong, but readable aloud and retypable
//   passwordProblem   -- the one rule a chosen password must meet
//   resetProblem      -- who may set whose password (pure, testable)
//   resetRefusal      -- the same, with the two accounts' access looked up
//   applyPassword     -- hash it and end every session the old one opened
//
// The password itself is never stored or logged in the clear. A generated
// one goes back to the admin once, in the response that set it; the audit
// trail records that it happened with the body's password field hidden
// (models/adminAuditLogModel.js).

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { isAdmin, widerTab, deskGrantBeyond } = require('./roleGuards');

// Minimum that is worth enforcing. Deliberately a length rule and nothing
// else: composition rules push people towards "Password1!" and no further.
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

/** Generates a readable but strong password. */
function generatePassword(length = 14) {
  // Ambiguous glyphs (0/O, 1/l/I) omitted so the password survives being
  // read out across a desk, or out of an email, and retyped.
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*';
  const all = upper + lower + digits + symbols;
  const pick = (set) => set[crypto.randomInt(0, set.length)];
  // Guarantee one of each class, then fill and shuffle.
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** The sentence explaining why `password` will not do, or null. */
function passwordProblem(password) {
  if (!password || typeof password !== 'string') return 'A new password is required';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return 'Password is too long';
  return null;
}

function same(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/**
 * May `actor` set `target`'s password? Setting a password is signing in as
 * that person, so nobody may do it to an account that could reach anything
 * their own cannot -- the same line the role guards hold on creating,
 * promoting, demoting and removing accounts (services/roleGuards.js), so
 * there is no way round it through a role change.
 *
 *   * not your own -- that is "change password", which asks for the
 *     current one, from the account page;
 *   * an administrator's only by an administrator;
 *   * otherwise the target's role may not hold any tab at a higher level
 *     than the actor's, nor a front-desk grant the actor lacks.
 *
 * @param {{ actorId, actorRole, actorPermissions, actorGrants, target, targetPermissions }} args
 *   permissions are { tab: level } maps (roleService.permissionsFor);
 *   grants and target carry allowAttendanceApp / allowFingerprintEnrollment.
 * @returns {string|null} the refusal, or null when it may go ahead
 */
function resetProblem({ actorId, actorRole, actorPermissions, actorGrants = {}, target, targetPermissions }) {
  if (!target) return null;

  if (same(actorId, target._id || target.id)) {
    return 'Change your own password from your account page, where it asks for the current one.';
  }

  if (isAdmin(target.role) && !isAdmin(actorRole)) {
    return "Only an administrator can set an administrator's password.";
  }

  // An administrator reaches everything already.
  if (isAdmin(actorRole)) return null;

  const wider = widerTab(actorPermissions, targetPermissions);
  if (wider) {
    return `This account has more access than yours (${wider}), so ask an administrator to set its password.`;
  }

  if (deskGrantBeyond(actorGrants, target)) {
    return 'This account can use the front-desk app and yours cannot, so ask an administrator to set its password.';
  }

  return null;
}

/**
 * resetProblem with the accounts' live roles and grants read from the
 * database (roleService.actorAccess).
 */
async function resetRefusal(req, target) {
  const { actorAccess, permissionsFor } = require('./roleService');
  return resetProblem({
    ...(await actorAccess(req)),
    target,
    targetPermissions: await permissionsFor(target.role)
  });
}

/**
 * Sets `plain` as the password on a loaded user document and ends every
 * session the old one opened: website and phone tokens (tokenVersion), the
 * session cache, and any front-desk app sign-in. A reset link already in the
 * inbox dies too.
 */
async function applyPassword(user, plain) {
  user.password = await bcrypt.hash(plain, await bcrypt.genSalt(10));
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.passwordResetTokenHash = null;
  user.passwordResetExpiresAt = null;
  user.passwordChangedAt = new Date();
  await user.save();

  const { forgetSession } = require('../middleware/auth');
  forgetSession(user._id);
  try {
    const DesktopToken = require('../attendance/models/desktopTokenModel');
    await DesktopToken.revokeAllForUser(user._id);
  } catch (error) {
    // The password has changed either way; a desk still signed in drops out
    // when its token next expires.
    console.error('[passwords] could not revoke desk sign-ins of', String(user._id), '-', error.message);
  }
  return user;
}

const CREDENTIAL_MODES = ['email', 'show', 'set'];

/**
 * How a new account gets its first password, from the create forms:
 *
 *   credentials 'email' -- generate one and email it (the default)
 *   credentials 'show'  -- generate one and hand it to the admin, once
 *   credentials 'set'   -- the admin typed one (`password`)
 *
 * A `password` sent without `credentials` means 'set'. 'email' for an
 * account with nowhere to send it becomes 'show'.
 *
 * @returns {{ mode, password } | { problem }}
 */
function initialPassword(body = {}, { canEmail = true } = {}) {
  const typed = body.password;
  let mode = String(body.credentials || '').toLowerCase().trim();
  if (!CREDENTIAL_MODES.includes(mode)) mode = typed ? 'set' : 'email';

  if (mode === 'set') {
    const problem = passwordProblem(typed);
    return problem ? { problem } : { mode, password: typed };
  }
  if (mode === 'email' && !canEmail) mode = 'show';
  return { mode, password: generatePassword() };
}

/**
 * The `POST .../:id/password { password? }` handler for one screen.
 * `load(id)` finds the account the screen may touch (null: 404);
 * `notFound` is that screen's word for a missing one.
 *
 * With a password, it is checked and set; without one, a strong one is
 * generated and returned in this response -- the only time it leaves the
 * server. The response is marked no-store so no cache keeps a copy.
 */
function setPasswordHandler({ load, notFound = 'User not found' }) {
  return async (req, res) => {
    try {
      const mongoose = require('mongoose');
      if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) {
        return res.status(404).json({ success: false, message: notFound });
      }
      const user = await load(req.params.id);
      if (!user) return res.status(404).json({ success: false, message: notFound });

      const refusal = await resetRefusal(req, user);
      if (refusal) return res.status(403).json({ success: false, message: refusal });

      const typed = req.body && req.body.password;
      const chosen = typed !== undefined && typed !== null && typed !== '';
      if (chosen) {
        const problem = passwordProblem(typed);
        if (problem) return res.status(400).json({ success: false, message: problem });
      }
      const password = chosen ? typed : generatePassword();

      await applyPassword(user, password);

      const who = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'This account';
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        success: true,
        message: chosen
          ? `${who}'s password has been changed and they have been signed out everywhere.`
          : `A new password was generated for ${who}. It is shown once: hand it over now.`,
        data: {
          id: String(user._id),
          username: user.username || null,
          generated: !chosen,
          // Only a generated password comes back: a typed one the admin
          // already knows, and echoing it would only put it in more logs.
          ...(chosen ? {} : { password })
        }
      });
    } catch (error) {
      console.error('[passwords] set failed:', error);
      return res.status(500).json({ success: false, message: 'Could not set the password' });
    }
  };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  generatePassword,
  passwordProblem,
  initialPassword,
  resetProblem,
  resetRefusal,
  applyPassword,
  setPasswordHandler
};
