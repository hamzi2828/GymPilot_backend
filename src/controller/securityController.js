// src/controller/securityController.js
//
// Account security and the member's rights over their data: the second
// sign-in step, ending every session at once, consent to fingerprint
// storage, a copy of everything the gym holds about them, and the admin
// audit trail.

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/user');
const PackageOrder = require('../gymfolio/models/packageOrderModel');
const ClassBooking = require('../gymfolio/models/classBookingModel');
const Attendance = require('../attendance/models/attendanceModel');
const Fingerprint = require('../attendance/models/fingerprintModel');
const Contact = require('../models/contactModel');
const AdminAuditLog = require('../models/adminAuditLogModel');
const twoFactor = require('../services/twoFactorService');
const verification = require('../services/emailVerification');
const { gymSiteName } = require('../services/gymName');
const { currentTenantId, currentTenantSlug, frontendOrigin } = require('../platform/tenantContext');
const { forgetSession } = require('../middleware/auth');
const { publicUserView } = require('../services/userView');
const guards = require('../services/roleGuards');
const { actorAccess, permissionsFor } = require('../services/roleService');

const BIOMETRIC_CONSENT_VERSION = '2026-09';

/**
 * The same token loginUser issues, so a 2FA sign-in is no different
 * afterwards -- including the month-long life a "remember me" sign-in gets.
 */
function issueToken(user, { remember = false } = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Server misconfiguration: missing JWT secret');
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tid: currentTenantId(),
      tv: user.tokenVersion || 0
    },
    secret,
    { expiresIn: remember ? '30d' : '7d' }
  );
}

// One view of an account for every sign-in response (services/userView.js).
const publicUser = publicUserView;

// What an admin action here is judged on, about the account it is done to.
const REACH_FIELDS = 'role allowAttendanceApp allowFingerprintEnrollment';

// Why the caller may not `doing` this account, or null (services/roleGuards.js).
async function reachRefusal(req, target, doing) {
  return guards.reachProblem({ ...(await actorAccess(req)), target, targetPermissions: await permissionsFor(target.role), doing });
}

function nameOf(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'This account';
}

function consentRecord(given, source, by) {
  return { given: !!given, at: new Date(), source, recordedBy: by || null, version: BIOMETRIC_CONSENT_VERSION };
}

module.exports = {
  issueToken,
  BIOMETRIC_CONSENT_VERSION,

  // POST /user/login/2fa   { challengeId, code }
  verifyTwoFactor: async (req, res) => {
    try {
      const { challengeId, code } = req.body || {};
      // "Remember me" was recorded on the challenge at the password step;
      // verify() clears the challenge, so it is read first.
      const pending = challengeId
        ? await User.findOne({ 'twoFactor.pending.challengeId': String(challengeId) }).select('twoFactor.pending.remember').lean()
        : null;
      const remember = !!(pending && pending.twoFactor && pending.twoFactor.pending && pending.twoFactor.pending.remember);

      const user = await twoFactor.verify(challengeId, code);
      if (user.isActive === false) return res.status(403).json({ message: 'This account has been deactivated.' });

      user.lastLogin = new Date();
      await user.save();

      return res.status(200).json({ message: 'Login successful', token: issueToken(user, { remember }), data: publicUser(user) });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
      console.error('[2fa] verify failed:', error);
      return res.status(500).json({ message: 'Could not verify the code' });
    }
  },

  // PUT /user/two-factor   { enabled }  -- for one's own account
  setMyTwoFactor: async (req, res) => {
    try {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ message: 'Account not found' });
      const enabled = !!(req.body && (req.body.enabled === true || req.body.enabled === 'true'));
      // The code arrives by email; switching this on with no address, or
      // with mail broken, would lock the account out at its next sign-in.
      if (enabled && !user.email) {
        return res.status(409).json({ message: 'Two-factor sign-in emails you a code, and this account has no email address. Ask the gym to add one first.' });
      }
      if (enabled) {
        const { verifyConnection } = require('../services/emailService');
        const smtp = await verifyConnection();
        if (!smtp.ok) {
          return res.status(409).json({ message: `Email is not working right now (${smtp.error}), so two-factor sign-in cannot be switched on. Ask the gym to check its email settings.` });
        }
      }
      user.twoFactor = user.twoFactor || {};
      user.twoFactor.enabled = enabled;
      await user.save();
      return res.json({ success: true, message: user.twoFactor.enabled ? 'Two-factor sign-in is on. We will email you a code each time you sign in.' : 'Two-factor sign-in is off.', data: { enabled: user.twoFactor.enabled } });
    } catch (error) {
      console.error('[2fa] set failed:', error);
      return res.status(500).json({ message: 'Could not update two-factor settings' });
    }
  },

  // GET /user/verify-email?token=   -- the link in the "confirm your email"
  // message. Shows a page with one button and changes nothing: mail scanners
  // open every link in a message, and one of those must not confirm an
  // address for whoever typed it (services/emailVerification.js).
  verifyEmailPage: async (req, res) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const [account, siteName] = await Promise.all([verification.pending(token), gymSiteName()]);
      res.setHeader('Cache-Control', 'no-store');
      if (!account) return res.status(400).type('html').send(verification.invalidPage({ siteName }));
      return res.status(200).type('html').send(verification.confirmPage({ siteName, email: account.email, token, slug: currentTenantSlug() }));
    } catch (error) {
      console.error('[security] confirmation page failed:', error);
      return res.status(500).type('text/plain').send('Could not open this link. Please try again.');
    }
  },

  // POST /user/verify-email   { token }  -- the button on that page (a form
  // post, answered by sending the person to the gym's sign-in page), or a
  // JSON call from the website or the app (answered in JSON).
  verifyEmail: async (req, res) => {
    const wantsJson = typeof req.is === 'function' && !!req.is('application/json');
    try {
      const token = req.body && typeof req.body.token === 'string' ? req.body.token : '';
      const account = await verification.confirm(token);
      res.setHeader('Cache-Control', 'no-store');
      if (!account) {
        if (wantsJson) return res.status(400).json({ success: false, code: 'VERIFY_LINK_INVALID', message: verification.LINK_INVALID });
        return res.status(400).type('html').send(verification.invalidPage({ siteName: await gymSiteName() }));
      }
      if (wantsJson) return res.status(200).json({ success: true, message: 'Your email address is confirmed.', data: { email: account.email, emailVerified: true } });
      return res.redirect(303, `${frontendOrigin()}/authentication?emailVerified=1`);
    } catch (error) {
      console.error('[security] confirming an email failed:', error);
      if (wantsJson) return res.status(500).json({ success: false, message: 'Could not confirm your email address' });
      return res.status(500).type('text/plain').send('Could not confirm your email address. Please try again.');
    }
  },

  // POST /user/verify-email/send -- a fresh link for the signed-in account
  sendVerifyEmail: async (req, res) => {
    try {
      const user = await User.findById(req.user.id).select('firstName email emailVerified');
      if (!user) return res.status(404).json({ message: 'Account not found' });
      if (!user.email) return res.status(409).json({ success: false, message: 'This account has no email address to confirm.' });
      if (verification.emailIsVerified(user)) {
        return res.json({ success: true, alreadyVerified: true, message: 'Your email address is already confirmed.' });
      }
      const result = await verification.sendLink(user, { origin: verification.apiOrigin(req) });
      if (!result.sent) {
        return res.status(503).json({ success: false, message: 'We could not send the email just now. Please try again later, or ask at reception.' });
      }
      return res.json({ success: true, message: `We sent a link to ${user.email}. Open it to confirm the address is yours.` });
    } catch (error) {
      console.error('[security] sending a confirmation link failed:', error);
      return res.status(500).json({ message: 'Could not send the confirmation email' });
    }
  },

  // POST /admin/users/:id/verify-email  (staff) -- the desk vouches for an
  // address: the member is standing there, the membership they bought as a
  // guest is under it, and the emailed link was never opened.
  vouchEmail: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'User not found' });
      const user = await User.findById(req.params.id).select(`firstName lastName username email emailVerified ${REACH_FIELDS}`);
      if (!user) return res.status(404).json({ message: 'User not found' });
      // Not your own: that would be vouching for an address you typed.
      if (String(user._id) === String(req.user.id)) {
        return res.status(403).json({ message: 'Confirm your own email address from the link we emailed you.' });
      }
      const refusal = await reachRefusal(req, user, 'confirm the email address of');
      if (refusal) return res.status(403).json({ message: refusal });
      if (!user.email) return res.status(409).json({ message: 'This account has no email address to confirm.' });

      await User.updateOne({ _id: user._id, email: user.email }, { $set: { emailVerified: true, emailVerifyTokenHash: null, emailVerifyExpiresAt: null } });
      return res.json({ success: true, message: `${nameOf(user)}'s email address is marked as confirmed.`, data: { id: String(user._id), emailVerified: true } });
    } catch (error) {
      console.error('[security] vouching for an email failed:', error);
      return res.status(500).json({ message: 'Could not confirm the email address' });
    }
  },

  // POST /user/logout-all -- ends every session of the signed-in account
  logoutAll: async (req, res) => {
    try {
      const user = await User.findByIdAndUpdate(req.user.id, { $inc: { tokenVersion: 1 } }, { new: true }).select('tokenVersion');
      if (!user) return res.status(404).json({ message: 'Account not found' });
      forgetSession(user._id);
      return res.json({ success: true, message: 'Signed out everywhere. Sign in again to continue.' });
    } catch (error) {
      console.error('[security] logout-all failed:', error);
      return res.status(500).json({ message: 'Could not sign out other sessions' });
    }
  },

  // POST /admin/users/:id/logout-all  (staff)
  forceLogout: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'User not found' });
      const user = await User.findByIdAndUpdate(req.params.id, { $inc: { tokenVersion: 1 } }, { new: true }).select('email');
      if (!user) return res.status(404).json({ message: 'User not found' });
      forgetSession(user._id);
      return res.json({ success: true, message: `${user.email} has been signed out of every device.` });
    } catch (error) {
      console.error('[security] force logout failed:', error);
      return res.status(500).json({ message: 'Could not sign the user out' });
    }
  },

  // PUT /user/consents   { biometric: true|false }  -- the member, for themselves
  setMyConsent: async (req, res) => {
    try {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ message: 'Account not found' });
      const body = req.body || {};
      if (body.biometric === undefined) return res.status(400).json({ message: 'Nothing to update' });

      const given = body.biometric === true || body.biometric === 'true';
      user.consents = user.consents || {};
      user.consents.biometric = consentRecord(given, 'portal', user._id);
      await user.save();

      // Withdrawing consent means the templates go too.
      let removed = 0;
      if (!given) {
        const result = await Fingerprint.deleteMany({ personType: { $in: ['member', 'staff'] }, personId: user._id });
        removed = result.deletedCount || 0;
      }

      return res.json({
        success: true,
        message: given ? 'Thanks — you can now register a fingerprint at reception.' : `Consent withdrawn${removed ? ` and ${removed} stored fingerprint(s) deleted` : ''}.`,
        data: { biometric: user.consents.biometric, fingerprintsRemoved: removed }
      });
    } catch (error) {
      console.error('[security] consent failed:', error);
      return res.status(500).json({ message: 'Could not update consent' });
    }
  },

  // PUT /admin/users/:id/consent   { biometric: true|false }  -- staff, after a signed form
  recordConsent: async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'User not found' });
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ message: 'User not found' });
      const body = req.body || {};
      if (body.biometric === undefined) return res.status(400).json({ message: 'Nothing to update' });

      const given = body.biometric === true || body.biometric === 'true';
      user.consents = user.consents || {};
      user.consents.biometric = consentRecord(given, 'desk', req.user.id);
      await user.save();

      let removed = 0;
      if (!given) {
        const result = await Fingerprint.deleteMany({ personId: user._id });
        removed = result.deletedCount || 0;
      }
      return res.json({
        success: true,
        message: given ? `Biometric consent recorded for ${user.email}.` : `Consent withdrawn for ${user.email}${removed ? `; ${removed} fingerprint(s) deleted` : ''}.`,
        data: { biometric: user.consents.biometric }
      });
    } catch (error) {
      console.error('[security] record consent failed:', error);
      return res.status(500).json({ message: 'Could not record consent' });
    }
  },

  // GET /user/export -- everything the gym holds about the signed-in member
  exportMyData: async (req, res) => {
    try {
      // The member's own health details, documents and (for staff) pay
      // details are theirs and belong in the copy; they are `select: false`
      // on the model, so they are asked for by name.
      const user = await User.findById(req.user.id).select('+medical +documents +employment.payroll');
      if (!user) return res.status(404).json({ message: 'Account not found' });

      // Matched by email as well only when the account has one: without it,
      // `{ email: undefined }` would match every record that has none -- other
      // people's orders and enquiries. And only once the address is shown to
      // be theirs: sign-up takes any address, and this is a download of
      // whatever was bought or asked under it (services/emailVerification.js).
      const ownsEmail = !!user.email && verification.emailIsVerified(user);
      const [orders, bookings, attendance, fingerprints, contacts] = await Promise.all([
        PackageOrder.find(ownsEmail ? { $or: [{ userId: user._id }, { 'customerInfo.email': user.email }] } : { userId: user._id }).lean(),
        ClassBooking.find({ userId: user._id }).lean(),
        // Every visit on record, voided ones included: an export is the
        // member's whole data, not what the totals count.
        Attendance.find({ personId: user._id }).setOptions({ withVoided: true }).sort({ checkInAt: -1 }).lean(),
        Fingerprint.find({ personId: user._id }).select('fingerIndex enrolledByName enrolledDevice isActive createdAt updatedAt').lean(),
        // Enquiries keep the address as `emailAddress`.
        ownsEmail ? Contact.find({ emailAddress: user.email }).lean().catch(() => []) : []
      ]);

      // Start from the sign-in view, then add back what is the member's own.
      // The staff-only notes (staffNotes, medical.notes) stay out: they are
      // about the member, not for them, the same as on the profile screen.
      const full = user.toObject();
      const account = publicUser(user);
      if (full.medical) {
        const { notes: _notes, ...medical } = full.medical;
        account.medical = medical;
      }
      account.documents = full.documents || [];
      if (full.employment && full.employment.payroll) {
        account.employment = { ...(account.employment || {}), payroll: full.employment.payroll };
      }

      const payload = {
        exported_at: new Date().toISOString(),
        note: 'A copy of the personal data this gym holds about you. Fingerprint templates are encrypted and not included; only the fact that they exist.'
          + (user.email && !ownsEmail ? ' Your email address is not confirmed yet, so anything bought or asked as a guest under it is left out: confirm it from the link we emailed you and download again.' : ''),
        account,
        memberships: orders,
        class_bookings: bookings,
        attendance,
        fingerprints_on_file: fingerprints,
        enquiries: contacts
      };

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`);
      return res.send(JSON.stringify(payload, null, 2));
    } catch (error) {
      console.error('[security] export failed:', error);
      return res.status(500).json({ message: 'Could not export your data' });
    }
  },

  // GET /admin/audit-log?tab=&actor=&page=
  auditLog: async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
      const query = {};
      if (req.query.tab) query.tab = String(req.query.tab);
      if (req.query.actor) query.actorEmail = new RegExp(String(req.query.actor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (req.query.method) query.method = String(req.query.method).toUpperCase();

      const [rows, total] = await Promise.all([
        AdminAuditLog.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        AdminAuditLog.countDocuments(query)
      ]);
      return res.json({ success: true, data: rows, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
    } catch (error) {
      console.error('[audit] list failed:', error);
      return res.status(500).json({ message: 'Could not load the audit log' });
    }
  }
};
