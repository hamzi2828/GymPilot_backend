// src/controller/userController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/user');
const { getUserFromToken } = require('../helper/helper');
const crypto = require('crypto');
const { sendEmail } = require('../services/emailService');
const { frontendOrigin: tenantOrigin, currentTenantId, currentTenantSlug } = require('../platform/tenantContext');
const { checkLimit } = require('../platform/planLimits');
const { forgetSession } = require('../middleware/auth');
const { publicUserView } = require('../services/userView');
const guards = require('../services/roleGuards');
const { actorAccess, permissionsFor } = require('../services/roleService');
const { gymSiteName } = require('../services/gymName');
const notify = require('../services/gymNotifications');
const { afterResponse } = require('../services/afterResponse');
const { assignMemberCode } = require('../attendance/services/peopleDirectory');
const { profileFieldsFrom } = require('../services/memberFields');
const { currentPasswordRefusal } = require('../services/passwordCheck');
const { escapeHtml } = require('../templates/gymEmails');
const verification = require('../services/emailVerification');
const signInLock = require('../services/signInLock');
const oauthState = require('../services/oauthState');

// One answer for a name nobody has, a wrong password, an account that has
// no password because it only ever used Google, and one whose password is
// paused after too many wrong ones (services/signInLock.js). Any other
// wording for one of them tells whoever is asking that the account exists.
const SIGN_IN_REJECTED = `That email or username and password do not match. ${signInLock.PAUSE_NOTE}`;

// A signed-in session lasts a week; "remember me" on the sign-in form makes
// it a month, the same life the phone app's sessions get.
const SESSION_TTL = '7d';
const REMEMBERED_SESSION_TTL = '30d';

function wantsRemember(body) {
  const value = body && body.remember;
  return value === true || value === 'true' || value === 1 || value === '1';
}

// The role an admin action is judged by: the live one requirePermission just
// read (req.roleSlug), never the claim in a token that may predate a demotion.
function actorRole(req, fallback) {
    return req.roleSlug || (req.user && req.user.role) || (fallback && fallback.role) || '';
}

async function activeAdminCount() {
    return User.countDocuments({ role: guards.ADMIN_SLUG, isActive: true });
}

// What has to happen when an account is deleted, beyond the document going:
// its username is released in the platform directory (or the phone app keeps
// resolving it to a gym), its front-desk tokens stop working, and any
// fingerprint templates -- biometric data that must not outlive the person --
// are removed. None of these may block the deletion itself; a failure is
// logged and the account is still gone.
async function releaseAccount(user) {
    const id = user._id || user.id;
    try {
        const MemberDirectory = require('../platform/models/memberDirectoryModel');
        await MemberDirectory.withdraw(user);
    } catch (error) {
        console.error('[users] could not release the username of', String(id), '-', error.message);
    }
    try {
        const DesktopToken = require('../attendance/models/desktopTokenModel');
        await DesktopToken.revokeAllForUser(id);
    } catch (error) {
        console.error('[users] could not revoke desktop tokens of', String(id), '-', error.message);
    }
    try {
        const Fingerprint = require('../attendance/models/fingerprintModel');
        await Fingerprint.deleteMany({ personId: id });
    } catch (error) {
        console.error('[users] could not delete fingerprints of', String(id), '-', error.message);
    }
    // A deleted account's phones and browsers must stop getting the gym's
    // notifications.
    try {
        const MobilePushToken = require('../models/mobilePushTokenModel');
        const PushSubscription = require('../models/pushSubscriptionModel');
        await Promise.all([MobilePushToken.deleteMany({ userId: id }), PushSubscription.deleteMany({ userId: id })]);
    } catch (error) {
        console.error('[users] could not delete push registrations of', String(id), '-', error.message);
    }
    forgetSession(id);
}

// A card subscription has to stop before its member's account goes. The
// order stays (it is the gym's record of the sale), but with the account gone
// nobody could sign in to cancel it, and Stripe would go on charging.
//
// The cancelling belongs to the payment service --
// gymfolioPaymentService.cancelMemberSubscriptions(userId, { source, by }),
// which resolves once every subscription of the member is stopped at Stripe
// and throws (STRIPE_CANCEL_FAILED) when one could not be. It is looked up
// when needed, so the account screens do not load Stripe, and checked for, so
// a build without it refuses rather than deletes a member still being billed.
//
// Resolves to null when the account may go, or to the 409 body to send.
async function subscriptionsBlockDeletion(userId, { self, by = null }) {
    const refusal = (staffDetail) => ({
        code: 'SUBSCRIPTION_ACTIVE',
        message: self
            ? 'Your membership renews by card and we could not cancel it just now. Cancel it from your account page or at reception, then delete your account.'
            // Staff get the payment service's own account of what failed
            // (which subscription, and what to do about it) where there is one.
            : staffDetail || 'This member has a card subscription that could not be cancelled. Cancel it from Package Orders first, then delete the account.'
    });

    let payments = null;
    try {
        payments = require('../services/gymfolioPaymentService');
    } catch (error) {
        console.error('[users] payment service unavailable:', error.message);
    }

    if (payments && typeof payments.cancelMemberSubscriptions === 'function') {
        try {
            await payments.cancelMemberSubscriptions(userId, {
                source: self ? 'member' : 'staff',
                by,
                reason: 'Account deleted'
            });
            return null;
        } catch (error) {
            console.error('[users] could not cancel the subscriptions of', String(userId), '-', error.message);
            return refusal(error && error.code === 'STRIPE_CANCEL_FAILED' ? error.message : '');
        }
    }

    // No way to cancel from here: refuse only while a subscription would
    // still take another payment.
    const PackageOrder = require('../gymfolio/models/packageOrderModel');
    const live = await PackageOrder.exists({
        userId,
        'payment.stripeSubscriptionId': { $nin: [null, ''] },
        status: { $in: ['active', 'frozen', 'past_due'] },
        'subscription.cancelAtPeriodEnd': { $ne: true },
        'subscription.stripeStatus': { $nin: ['canceled', 'incomplete_expired'] }
    });
    return live ? refusal('') : null;
}

// Everything put into these two emails is escaped (templates/gymEmails.js
// escapeHtml). The first name is whatever was typed at sign-up, and sign-up
// takes any address: markup in it would otherwise reach that address's real
// owner inside a genuine email from the gym, link and all.
function welcomeEmailHtml({ firstName, email, username, password, siteName, loginUrl }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b">
    <h2 style="margin:0 0 16px;font-size:20px">Welcome to ${escapeHtml(siteName)}, ${escapeHtml(firstName)}</h2>
    <p style="margin:0 0 16px;line-height:1.6">An account has been created for you. Use these details to sign in:</p>
    <table style="width:100%;border-collapse:collapse;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;margin-bottom:16px">
      <tr><td style="padding:12px 16px;border-bottom:1px solid #e4e4e7;color:#71717a;font-size:13px">Email</td>
          <td style="padding:12px 16px;border-bottom:1px solid #e4e4e7;font-weight:600">${escapeHtml(email)}</td></tr>
      ${username ? `<tr><td style="padding:12px 16px;border-bottom:1px solid #e4e4e7;color:#71717a;font-size:13px">Username</td>
          <td style="padding:12px 16px;border-bottom:1px solid #e4e4e7;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(username)}</td></tr>` : ''}
      <tr><td style="padding:12px 16px;color:#71717a;font-size:13px">Temporary password</td>
          <td style="padding:12px 16px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(password)}</td></tr>
    </table>
    <p style="margin:0 0 20px;line-height:1.6">Please change this password after your first sign-in.${username ? ' You can sign in with your email or your username, here and on the GymPilot phone app.' : ''}</p>
    <a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Sign in</a>
    <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa">If you were not expecting this email, you can ignore it.</p>
  </div>`;
}

function passwordResetEmailHtml({ firstName, siteName, resetUrl, validMinutes }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b">
    <h2 style="margin:0 0 16px;font-size:20px">Reset your ${escapeHtml(siteName)} password</h2>
    <p style="margin:0 0 16px;line-height:1.6">Hi ${escapeHtml(firstName)}, we received a request to reset the password on your account. Click the button below to choose a new one.</p>
    <a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Choose a new password</a>
    <p style="margin:20px 0 0;line-height:1.6;font-size:13px;color:#71717a">This link is valid for ${escapeHtml(validMinutes)} minutes and can only be used once.</p>
    <p style="margin:16px 0 0;line-height:1.6;font-size:13px;color:#71717a">If the button does not work, paste this into your browser:<br>
      <span style="word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px">${escapeHtml(resetUrl)}</span></p>
    <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa">If you did not ask for this, you can ignore this email — your password will not change.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Password reset
//
// The link that goes out contains a random token; what is stored is only its
// SHA-256 hash, for the same reason the password itself is hashed. Someone
// who reads the database cannot reset anyone's password with what they find.
// ---------------------------------------------------------------------------

const RESET_TOKEN_TTL_MINUTES = 60;

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// The password rule (a length, nothing else) and the generator live with the
// admin set-password code, so every screen applies the same ones.
const { passwordProblem, initialPassword, setPasswordHandler } = require('../services/adminPasswords');

// Stores a fresh reset token on the account and emails the link. Run after
// the response has gone (see forgotPassword), so it reports trouble in the
// log, never to the caller.
async function sendResetLink(user, email) {
  // Raw token goes in the email; only its hash is stored -- and only while
  // the account still has the address the link is going to. A reset through
  // it later counts as proof of that address (resetPassword), so a link must
  // never outlive a change of address made while it was being sent.
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(token);
  const stored = await User.updateOne(
    { _id: user._id, email },
    { $set: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000) } }
  );
  if (!stored.matchedCount) return;

  const siteName = await gymSiteName();
  const frontend = tenantOrigin();
  const resetUrl =
    `${frontend}/authentication?mode=reset&token=${encodeURIComponent(token)}` +
    `&email=${encodeURIComponent(email)}`;

  const result = await sendEmail(
    email,
    `Reset your ${siteName} password`,
    passwordResetEmailHtml({
      firstName: user.firstName || 'there',
      siteName,
      resetUrl,
      validMinutes: RESET_TOKEN_TTL_MINUTES
    })
  );

  if (!result.success) {
    // The token is live but unreachable. Clearing it stops a link
    // nobody received from sitting valid for an hour, and the
    // logged error is how an admin finds out SMTP is misconfigured.
    console.error('[auth] reset email failed for', email, '-', result.error);
    await User.updateOne(
      { _id: user._id, passwordResetTokenHash: tokenHash },
      { $set: { passwordResetTokenHash: null, passwordResetExpiresAt: null } }
    );
  }
}

// ---------------------------------------------------------------------------
// Public sign-up and Google sign-in
// ---------------------------------------------------------------------------

// What a visitor sees when the gym's plan has no room for another member.
// The plan and its limits are between the gym and GymPilot, not something to
// tell somebody trying to join; staff adding an account from the admin panel
// still get the plan wording and the PLAN_LIMIT_REACHED code their screens
// act on.
const SIGNUPS_CLOSED = {
  message: "This gym isn't taking new online sign-ups right now — please contact the gym.",
  code: 'SIGNUPS_CLOSED'
};

// Google has verified the address it hands over; nothing ever checked that
// whoever registered that address here with a password owns it. So the
// first time Google sign-in links into a password account that was not made
// through Google, the password is thrown away and every session it opened is
// ended: somebody who pre-registered the address loses their way in, and the
// real owner can set a password of their own with "forgot password".
async function linkGoogleAccount(user, { googleId, picture }) {
  const updates = {};
  if (!user.googleId && googleId) updates.googleId = googleId;
  if (user.provider !== 'google') updates.provider = 'google';
  if (picture && user.avatarUrl !== picture) updates.avatarUrl = picture;
  const takeover = user.provider !== 'google' && !!user.password;
  if (takeover) updates.password = null;
  // Google has checked the address, which is more than sign-up did.
  if (user.emailVerified === false) {
    updates.emailVerified = true;
    updates.emailVerifyTokenHash = null;
    updates.emailVerifyExpiresAt = null;
  }
  if (!Object.keys(updates).length) return user;

  await User.updateOne(
    { _id: user._id },
    takeover ? { $set: updates, $inc: { tokenVersion: 1 } } : { $set: updates }
  );
  if (takeover) {
    forgetSession(user._id);
    console.log('[auth] Google sign-in linked', user.email, '- its password was cleared and its sessions ended');
  }
  return User.findById(user._id);
}

// The emailed-code step password sign-in already has (twoFactorService;
// securityController.verifyTwoFactor finishes it). A Google sign-in must not
// be the way round it. Null when the account signs straight in.
async function twoFactorStep(user) {
  const twoFactor = require('../services/twoFactorService');
  if (!(await twoFactor.required(user))) return null;
  const challenge = await twoFactor.startChallenge(user);
  // Nothing is broken, the account just has no address: say so, not "try later".
  if (challenge.noEmail) return { status: 409, body: { message: twoFactor.NO_EMAIL_SIGN_IN } };
  if (!challenge.emailed) {
    return {
      status: 503,
      body: { message: 'We could not email your sign-in code. Please contact the gym.', error: challenge.error }
    };
  }
  return {
    status: 200,
    body: {
      requires2fa: true,
      challengeId: challenge.challengeId,
      message: `We emailed a 6-digit code to ${twoFactor.maskEmail(user.email)}.`
    }
  };
}

// Only Google's own error codes ("access_denied") are echoed back; anything
// else in the query string is somebody else's text on our page.
function googleErrorCode(error) {
  const code = String(error || '');
  return /^[a-z_]{1,64}$/i.test(code) ? code : 'unknown_error';
}

// What a duplicate-key refusal on an account means. A second member with no
// email is refused on the email index only while the gym's database still
// has the old always-unique one (scripts/migrateEmailIndex.js replaces it).
function duplicateMessage(error) {
    const key = (error && (error.keyValue || error.keyPattern)) || {};
    if ('email' in key && (key.email === null || key.email === undefined)) {
        return "This gym's database cannot hold a second member without an email yet: it needs a one-off update (scripts/migrateEmailIndex.js). Add an email address for now.";
    }
    if ('memberCode' in key) return 'That member ID is already in use';
    if ('username' in key) return 'That username is already in use';
    return 'Email already in use';
}

// ---------------------------------------------------------------------------
// Creating an account from the admin panel
//
// The work behind POST /admin/users, as a function of the request rather
// than a route, so a screen that does more in one go -- "add a member, sell
// them a package, take the payment" -- can create the account the same way
// and carry on with `user`, instead of copying these rules. Resolves to
// { status, body, user?, noStore? }: the answer to send, the account when
// one was made, and whether the answer carries a password (never cache it).
//
// body: { firstName, lastName, email?, phone?, role?,
//         gender?, dateOfBirth?, address?, staffNotes?,
//         credentials?: 'email' | 'show' | 'set', password? }
//
// The email is optional -- plenty of members never give one -- but then a
// phone number is required, so the gym can still reach them and find them
// at the desk. Such a member signs in with their username. The profile
// fields are the ones the desk takes down at the counter
// (services/memberFields.js); the rest of the profile is edited afterwards.
//
// How the first password reaches the person (services/adminPasswords.js
// initialPassword): emailed (the default), generated and shown to the admin
// once, or typed by the admin. An email that cannot be sent no longer throws
// the password away: it comes back in `password`, shown once, so a gym whose
// mail is down can still hand it over.
// ---------------------------------------------------------------------------
async function createMemberAccount(req, body = (req && req.body) || {}) {
    const fail = (status, message, extra = {}) => ({ status, body: { message, ...extra } });
    try {
        const { firstName, lastName, email, role, phone } = body;

        if (!firstName || !lastName) {
            return fail(400, 'First name and last name are required');
        }

        const normalisedEmail = String(email || '').toLowerCase().trim();
        const cleanPhone = String(phone || '').trim();
        if (!normalisedEmail && !cleanPhone) {
            return fail(400, 'Give an email address or a phone number');
        }
        if (normalisedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
            return fail(400, 'Please provide a valid email address');
        }

        const profile = profileFieldsFrom(body);
        if (profile.problem) return fail(400, profile.problem);

        // Only an address that was given is looked up: `{ email: '' }`
        // must never be asked, it means nothing.
        if (normalisedEmail && (await User.exists({ email: normalisedEmail }))) {
            return fail(409, 'Email already in use');
        }

        // Any live role may be assigned here, not just the three that
        // used to be hardcoded -- a gym can invent its own. Anything
        // unrecognised falls back to an ordinary member.
        const RoleModel = require('../models/roleModel');
        const { ensureDefaultRoles: ensureRoles } = require('../services/roleService');
        await ensureRoles();
        const requestedRole = await RoleModel.findOne({
            slug: String(role || '').toLowerCase().trim(),
            isActive: true
        });
        const assignedRole = requestedRole ? requestedRole.slug : 'user';

        // Nobody creates an account whose role reaches further than their
        // own -- an administrator least of all. Knowing a new account's
        // password is being able to sign in as it, and that holds however
        // the password travels: emailed, it goes to whatever address the
        // admin typed (services/roleGuards.js).
        const refusal = guards.createRoleProblem({
            ...(await actorAccess(req)),
            role: assignedRole,
            rolePermissions: await permissionsFor(assignedRole)
        });
        if (refusal) return fail(403, refusal);

        // Nowhere to email a password: it is shown to the admin instead.
        const initial = initialPassword(body, { canEmail: !!normalisedEmail });
        if (initial.problem) return fail(400, initial.problem);

        // A staff role needs an address for the emailed sign-in code
        // (services/twoFactorService.js needsEmail).
        const { needsEmail } = require('../services/twoFactorService');
        if (!normalisedEmail && needsEmail({ role: assignedRole, employment: { isStaff: !!(requestedRole && requestedRole.isStaff) } })) {
            return fail(400, 'Staff need an email address: two-factor sign-in emails them a code.');
        }

        // The gym's platform plan may cap how many accounts it can hold.
        const limit = await checkLimit(requestedRole && requestedRole.isStaff ? 'staff' : 'members');
        if (!limit.ok) return fail(403, limit.message, { code: limit.code });

        const { password } = initial;
        const salt = await bcrypt.genSalt(10);
        const hashed = await bcrypt.hash(password, salt);

        const user = await User.create({
            firstName: String(firstName).trim(),
            lastName: String(lastName).trim(),
            email: normalisedEmail || undefined,
            password: hashed,
            role: assignedRole,
            phone: cleanPhone || null,
            ...profile.fields,
            // Creating someone straight into a staff role should make them
            // staff, or they would be invisible on the Staff tab that
            // manages their payroll and roster.
            employment: { isStaff: !!(requestedRole && requestedRole.isStaff) },
        });
        // A member's ID from the start, for the card and the Users list.
        await assignMemberCode(user);

        // The account exists regardless of whether the email lands, so a
        // send failure is reported rather than failing the whole request.
        let emailed = false;
        let emailError = null;
        if (initial.mode === 'email') {
            try {
                const siteName = await gymSiteName();
                const loginUrl = `${tenantOrigin()}/authentication`;
                const result = await sendEmail(
                    normalisedEmail,
                    `Your ${siteName} account`,
                    welcomeEmailHtml({ firstName: user.firstName, email: normalisedEmail, username: user.username, password, siteName, loginUrl })
                );
                emailed = !!result.success;
                if (!result.success) emailError = result.error;
            } catch (err) {
                emailError = err.message;
            }
        }

        // Shown to the admin once: a generated password nobody else will
        // ever see -- asked for, or left over from an email that failed.
        const reveal = initial.mode === 'show' || (initial.mode === 'email' && !emailed);
        let message = 'User created with the password you chose';
        if (initial.mode === 'show') message = 'User created. Hand them the password below: it is shown only once';
        if (initial.mode === 'email') {
            message = emailed
                ? 'User created and credentials emailed'
                : 'User created, but the credentials email could not be sent. Hand them the password below: it is shown only once';
        }

        return {
            status: 201,
            user,
            noStore: reveal,
            body: {
                message,
                emailed,
                emailError,
                credentials: initial.mode,
                ...(reveal ? { password } : {}),
                data: publicUserView(user),
            }
        };
    } catch (error) {
        if (error && error.code === 11000) return fail(409, duplicateMessage(error));
        return fail(400, 'Error creating user', { error: error.message });
    }
}

// Why `account` may not remove its own email address, or null. A member may:
// email is optional, and they sign in with their username. Not an account
// that two-factor sign-in sends a code to (staff, or anyone who switched it
// on), and not a Google sign-in, which finds its account by this address.
function emailRemovalProblem(account) {
    const { needsEmail, isStaff } = require('../services/twoFactorService');
    if (needsEmail(account)) {
        return isStaff(account)
            ? 'Staff accounts keep an email address: two-factor sign-in sends the sign-in code to it.'
            : 'Two-factor sign-in sends your code to this address. Turn it off before removing the address.';
    }
    if (account.provider === 'google' || account.googleId || !account.password) {
        return 'This address is how you sign in with Google, so it cannot be removed.';
    }
    return null;
}

const userController = {


    // POST /admin/users - Admin creates a user (createMemberAccount above)
    adminCreateUser: async (req, res) => {
        const result = await createMemberAccount(req);
        if (result.noStore) res.setHeader('Cache-Control', 'no-store');
        return res.status(result.status).json(result.body);
    },

    // POST /admin/users/:id/password   { password? }
    //
    // An admin sets (or, with no password, generates) a member's or staff
    // member's password -- the way in when there is no email to reset from,
    // or the email is down. Ends every session the account had. Who may do
    // it to whom: services/adminPasswords.js resetProblem.
    setUserPassword: setPasswordHandler({
        load: (id) => User.findById(id),
        notFound: 'User not found'
    }),

    // PUT /admin/users/:id/username   { username }
    //
    // Staff choose the username instead of taking a generated one -- letters
    // and digits, unique across the platform (services/username.js).
    setUsername: require('../services/username').setUsernameHandler({
        load: (id) => User.findById(id),
        notFound: 'User not found'
    }),

    // POST /admin/users/:id/username - Issue a fresh username
    //
    // For the rare case where a member does not want the one they were given,
    // or two members with the same name keep confusing each other. The old
    // username stops working immediately, so the member has to be told.
    regenerateUsername: async (req, res) => {
        try {
            const user = await User.findById(req.params.id);
            if (!user) return res.status(404).json({ message: 'User not found' });

            // The same line as choosing one (services/adminPasswords.js).
            const { usernameRefusal } = require('../services/adminPasswords');
            const refusal = await usernameRefusal(req, user);
            if (refusal) return res.status(403).json({ message: refusal });

            const { assignUsername } = require('../services/username');
            const username = await assignUsername(user, { force: true });
            return res.json({ message: 'New username issued', data: { id: String(user._id), username } });
        } catch (error) {
            return res.status(400).json({ message: 'Could not issue a new username', error: error.message });
        }
    },

    // POST /user - Create a new user
    createUser: async (req, res) => {
        try {
            const { firstName, lastName, email, password, confirmPassword } = req.body;

            // Basic validation
            if (!firstName || !lastName || !email || !password) {
                return res.status(400).json({ message: 'Missing required fields' });
            }

            // Optional: enforce password confirmation if provided
            if (typeof confirmPassword !== 'undefined' && password !== confirmPassword) {
                return res.status(400).json({ message: 'Passwords do not match' });
            }

            // The same rule a reset or a change of password is held to
            // (services/adminPasswords.js): a length, nothing else.
            const problem = passwordProblem(password);
            if (problem) {
                return res.status(400).json({ message: problem });
            }

            // One address: the confirmation link below is sent to it.
            const normalisedEmail = String(email).toLowerCase().trim();
            if (!verification.looksLikeEmail(normalisedEmail)) {
                return res.status(400).json({ message: 'Please provide a valid email address' });
            }

            // Check if user already exists
            const existing = await User.findOne({ email: normalisedEmail });
            if (existing) {
                return res.status(409).json({ message: 'Email already in use' });
            }

            // The gym's platform plan may cap how many members it can hold.
            // This is the public sign-up form, so the visitor is told the
            // gym is not taking sign-ups, not about the gym's plan.
            const limit = await checkLimit('members');
            if (!limit.ok) return res.status(403).json({ ...SIGNUPS_CLOSED });

            // Hash password
            const salt = await bcrypt.genSalt(10);
            const hashed = await bcrypt.hash(password, salt);

            // Create user
            const user = await User.create({
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                email: normalisedEmail,
                password: hashed,
                // Anybody can type any address here. Until its owner opens
                // the link sent below, it claims nothing that was bought
                // under it (services/emailVerification.js).
                emailVerified: false,
            });

            await assignMemberCode(user);

            // The welcome email carries their username for the phone app,
            // which they are told nowhere else. Not waited for.
            afterResponse(() => notify.memberWelcome(user), 'welcome email');
            afterResponse(() => verification.sendLink(user, { origin: verification.apiOrigin(req) }), 'confirmation email');

            // Sanitize output
            return res.status(201).json({ message: 'User created successfully', data: publicUserView(user) });
        } catch (error) {
            // Handle duplicate key error from unique index
            if (error && error.code === 11000) {
                return res.status(409).json({ message: 'Email already in use' });
            }
            res.status(400).json({ message: 'Error creating user', error: error.message });
        }
    },

    // GET /auth/google - Start OAuth 2.0 Authorization Code flow (redirect)
    startGoogleOAuth: async (req, res) => {
        try {
            const clientId = process.env.GOOGLE_CLIENT_ID;
            const redirectUri = process.env.GOOGLE_REDIRECT_URI;
            if (!clientId || !redirectUri) {
                return res.status(500).send('Server misconfiguration: missing GOOGLE_CLIENT_ID or GOOGLE_REDIRECT_URI');
            }

            const scope = encodeURIComponent('openid email profile');
            const returnUrl = req.query.returnUrl || '/';
            const platformType = req.query.platformType || '';
            // The gym rides along in `state`: Google sends the callback to the
            // API's own address, which says nothing about which site started
            // the sign-in. See platform/middleware/tenantFromPayload.js. It is
            // signed, and tied to this browser by a cookie, so the sign-in can
            // only be finished where it was started (services/oauthState.js).
            const issued = oauthState.issue({ returnUrl, platformType, tenant: currentTenantSlug() });
            res.cookie(oauthState.COOKIE_NAME, issued.nonce, oauthState.cookieOptions(req));
            const state = encodeURIComponent(issued.state);
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&include_granted_scopes=true&prompt=consent&state=${state}`;

            return res.redirect(authUrl);
        } catch (error) {
            console.error('startGoogleOAuth error:', error);
            return res.status(400).send('Failed to start Google OAuth');
        }
    },

    // GET /auth/google/callback - Handle OAuth callback, exchange code, verify ID token, login
    googleOAuthCallback: async (req, res) => {
        try {
            const { code, state, error } = req.query;
            if (error) {
                return res.status(400).type('text/plain').send(`Google OAuth error: ${googleErrorCode(error)}`);
            }
            if (!code) {
                return res.status(400).send('Missing authorization code');
            }

            const clientId = process.env.GOOGLE_CLIENT_ID;
            const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
            const redirectUri = process.env.GOOGLE_REDIRECT_URI;
            if (!clientId || !clientSecret || !redirectUri) {
                return res.status(500).send('Server misconfiguration: missing Google OAuth envs');
            }

            // The state must be the one this server wrote, for this gym, and
            // come back in the browser that was given its cookie -- or this
            // is somebody else's sign-in being finished here
            // (services/oauthState.js). Checked before the code is spent.
            const stateData = oauthState.verify(state, oauthState.readCookie(req), currentTenantSlug());
            res.clearCookie(oauthState.COOKIE_NAME, { path: oauthState.cookieOptions(req).path });
            if (!stateData) {
                return res.status(400).type('text/plain').send('This sign-in did not start in this browser, or took too long. Please go back to the sign-in page and try again.');
            }
            const returnUrl = stateData.returnUrl || '/';

            const frontendOrigin = tenantOrigin();

            const oauthClient = new OAuth2Client(clientId, clientSecret, redirectUri);
            const { tokens } = await oauthClient.getToken({ code, redirect_uri: redirectUri });
            const idToken = tokens.id_token;
            if (!idToken) {
                return res.status(401).send('No ID token returned by Google');
            }

            const ticket = await oauthClient.verifyIdToken({ idToken, audience: clientId });
            const payload = ticket.getPayload();
            if (!payload) {
                return res.status(401).send('Invalid Google ID token');
            }

            const {
                sub: googleId,
                email,
                given_name: givenName,
                family_name: familyName,
                picture,
                email_verified: emailVerified,
            } = payload;

            if (!email || !emailVerified) {
                return res.status(401).send('Unverified Google account');
            }

            const normalizedEmail = String(email).toLowerCase().trim();

            // Upsert user by email
            let user = await User.findOne({ email: normalizedEmail });
            if (!user) {
                // A first Google sign-in creates a member, and the gym's plan
                // may cap how many members it can hold -- the same check the
                // sign-up form and the admin form make, with the sign-up
                // form's wording.
                const limit = await checkLimit('members');
                if (!limit.ok) return res.status(403).type('text/plain').send(SIGNUPS_CLOSED.message);

                user = await User.create({
                    firstName: givenName || 'Google',
                    lastName: familyName || 'User',
                    email: normalizedEmail,
                    password: null,
                    provider: 'google',
                    googleId: googleId || null,
                    avatarUrl: picture || null,
                    // Google has checked the address.
                    emailVerified: true,
                });
                // A new member, as from the sign-up form -- with no password
                // yet, which the phone app needs.
                await assignMemberCode(user);
                afterResponse(() => notify.memberWelcome(user, { viaGoogle: true }), 'welcome email');
            } else {
                user = await linkGoogleAccount(user, { googleId, picture });
            }

            if (user.isActive === false) {
                return res.status(403).type('text/plain').send('This account has been deactivated.');
            }

            // The token lands on the sign-in page, which stores it and then
            // sends the person on to `redirect` -- the same param the
            // password form honours -- rather than being sprayed onto
            // whichever page they started from. Only a same-site path is
            // carried; anything else falls back to the homepage.
            const safeReturn = typeof returnUrl === 'string' && returnUrl.startsWith('/') && !returnUrl.startsWith('//') && returnUrl !== '/'
                ? returnUrl
                : '';

            // Staff with two-factor on finish on the sign-in page with the
            // emailed code, exactly as after a password.
            const step = await twoFactorStep(user);
            if (step) {
                if (step.status !== 200) return res.status(step.status).type('text/plain').send(step.body.message);
                const params = new URLSearchParams({ requires2fa: '1', challengeId: step.body.challengeId });
                if (safeReturn) params.set('redirect', safeReturn);
                return res.redirect(`${frontendOrigin}/authentication?${params.toString()}`);
            }

            const secret = process.env.JWT_SECRET;
            if (!secret) {
                return res.status(500).send('Server misconfiguration: missing JWT secret');
            }
            const token = jwt.sign({
                id: user._id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
                tid: currentTenantId(),
                tv: user.tokenVersion || 0,
            }, secret, { expiresIn: SESSION_TTL });

            user.lastLogin = new Date();
            await user.save();

            const params = new URLSearchParams({ googleToken: token });
            if (safeReturn) params.set('redirect', safeReturn);
            return res.redirect(`${frontendOrigin}/authentication?${params.toString()}`);
        } catch (error) {
            console.error('googleOAuthCallback error:', error);
            return res.status(400).send('Failed to complete Google OAuth');
        }
    },

    // POST /user/login - Authenticate user and return JWT
    //
    // { email, password, remember? } -- `email` is whatever was typed into
    // the "Email or username" box (`login` or `username` are read too): an
    // address, or the username a member without one signs in with. Either
    // way, case does not matter (services/username.js loginFilter).
    loginUser: async (req, res) => {
        try {
            const { password } = req.body;
            // The same fields, in the same order, as the sign-in limiter
            // counts (middleware/rateLimit.js FIELDS.website).
            const login = req.body.login || req.body.email || req.body.username;
            const remember = wantsRemember(req.body);
            // Spaces alone make no filter at all, and findOne(null) is the
            // gym's first account -- its owner -- so they are refused here
            // rather than looked up.
            const { loginFilter } = require('../services/username');
            const filter = loginFilter(login);
            if (!filter || !password) {
                return res.status(400).json({ message: 'Email or username and password are required' });
            }

            const user = await User.findOne(filter);

            // One of the account's ten tries is used, then the password is
            // compared: a name nobody has costs the same bcrypt work and
            // gets the same answer as a wrong password or a paused account
            // (services/signInLock.js, services/passwordCheck.js). So does
            // an account with no password -- one made with Google. Saying
            // "this account uses Google" before any password was checked
            // told anybody who asked which addresses are members.
            if (!(await signInLock.signInPasswordMatches(user, password))) {
                return res.status(401).json({ message: SIGN_IN_REJECTED });
            }

            // Checked here as well as in requirePermission. That gate only
            // runs on permission-guarded routes, so without this a deactivated
            // account could still sign in and use every endpoint behind plain
            // `auth` -- their own profile, their attendance, the member
            // portal. Deactivating an account should end its access, not
            // narrow it.
            if (user.isActive === false) {
                return res.status(403).json({ message: 'This account has been deactivated.' });
            }

            // A second step by email for staff when the gym requires it, and
            // for anyone who switched it on for their own account. The token
            // is only issued once the code comes back (securityController).
            const twoFactor = require('../services/twoFactorService');
            if (await twoFactor.required(user)) {
                const challenge = await twoFactor.startChallenge(user);
                // Nothing is broken, the account just has no address: say so
                // (409), as the Google and phone-app sign-ins do, not "try later".
                if (challenge.noEmail) return res.status(409).json({ message: twoFactor.NO_EMAIL_SIGN_IN });
                if (!challenge.emailed) {
                    return res.status(503).json({
                        message: 'We could not email your sign-in code. Please contact the gym.',
                        error: challenge.error
                    });
                }
                // Carried on the challenge so the token issued at the code
                // step (securityController.verifyTwoFactor) gets the same
                // life the person asked for here.
                if (remember && user.twoFactor && user.twoFactor.pending) {
                    user.twoFactor.pending.remember = true;
                    await user.save();
                }
                return res.status(200).json({
                    requires2fa: true,
                    challengeId: challenge.challengeId,
                    message: `We emailed a 6-digit code to ${twoFactor.maskEmail(user.email)}.`
                });
            }

            const payload = {
                id: user._id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
                // Which gym issued this token; checked by middleware/auth so a
                // session from one gym's site cannot be replayed on another's.
                tid: currentTenantId(),
                tv: user.tokenVersion || 0,
            };

            const secret = process.env.JWT_SECRET;
            if (!secret) {
                return res.status(500).json({ message: 'Server misconfiguration: missing JWT secret' });
            }

            const token = jwt.sign(payload, secret, { expiresIn: remember ? REMEMBERED_SESSION_TTL : SESSION_TTL });

            // Update lastLogin timestamp
            user.lastLogin = new Date();
            await user.save();

            return res.status(200).json({ message: 'Login successful', token, data: publicUserView(user) });
        } catch (error) {
            res.status(500).json({ message: 'Error during login', error: error.message });
        }
    },

    // POST /user/forgot-password - Email a one-time reset link
    //
    // Always answers 200 with the same body, whether or not the address is on
    // file. Saying "no such account" here would turn this endpoint into a way
    // to find out who is a member, which is exactly the kind of thing a gym's
    // membership list should not confirm to anybody who asks.
    forgotPassword: async (req, res) => {
        const genericResponse = {
            message: 'If that email address has an account, a reset link is on its way.'
        };

        try {
            const { email } = req.body;
            if (!email) {
                return res.status(400).json({ message: 'Email is required' });
            }

            const normalisedEmail = String(email).toLowerCase().trim();
            const user = await User.findOne({ email: normalisedEmail });

            // No account or a deactivated one stops here, and looks
            // identical from outside. An account with no password -- a
            // member who joined with Google -- goes on: this is how they set
            // one, and the phone app signs in with a password only.
            //
            // The link is sent without being waited for (the way the gym's
            // other emails go out), so the answer comes back just as fast
            // whether or not the address has an account. Waiting on the mail
            // server only when it does would tell anyone with a stopwatch
            // who is a member. afterResponse keeps the send alive on Vercel
            // once the answer has gone.
            if (user && user.isActive !== false) {
                afterResponse(() => sendResetLink(user, normalisedEmail), 'password reset email');
            }

            return res.status(200).json(genericResponse);
        } catch (error) {
            console.error('forgotPassword error:', error);
            // Still generic: an error here must not become a way to probe
            // which addresses exist.
            return res.status(200).json(genericResponse);
        }
    },

    // POST /user/reset-password - Consume the emailed token and set a new password
    resetPassword: async (req, res) => {
        try {
            const { token, password } = req.body;

            if (!token) {
                return res.status(400).json({ message: 'Reset token is required' });
            }

            const problem = passwordProblem(password);
            if (problem) {
                return res.status(400).json({ message: problem });
            }

            // Looked up BY the hash, so an expired or forged token simply
            // finds nothing -- there is no branch here that reveals whether
            // the token existed but had lapsed.
            const user = await User.findOne({
                passwordResetTokenHash: hashResetToken(token),
                passwordResetExpiresAt: { $gt: new Date() }
            }).select('+passwordResetTokenHash +passwordResetExpiresAt +password');

            if (!user) {
                return res.status(400).json({
                    message: 'This reset link is invalid or has expired. Please request a new one.'
                });
            }

            if (user.isActive === false) {
                return res.status(403).json({ message: 'This account is disabled.' });
            }

            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(password, salt);
            // Wrong tries at the old password no longer count (signInLock).
            user.signInAttempts = 0;
            user.signInWindowEndsAt = null;
            // Every other session ends with the old password.
            user.tokenVersion = (user.tokenVersion || 0) + 1;
            forgetSession(user._id);

            // Single use: the token is spent whether or not the same person
            // clicks the link again.
            user.passwordResetTokenHash = null;
            user.passwordResetExpiresAt = null;
            user.passwordChangedAt = new Date();
            await user.save();

            // The link only ever went to the account's address (sendResetLink),
            // so whoever used it reads that mailbox: the address is theirs.
            await verification.markVerified(user._id, user.email);

            return res.status(200).json({
                message: 'Password updated. You can now sign in with your new password.'
            });
        } catch (error) {
            console.error('resetPassword error:', error);
            return res.status(500).json({ message: 'Could not reset password', error: error.message });
        }
    },

    // PUT /user/change-password - Signed-in change, current password required
    changePassword: async (req, res) => {
        try {
            const { currentPassword, newPassword } = req.body;

            const problem = passwordProblem(newPassword);
            if (problem) {
                return res.status(400).json({ message: problem });
            }

            const user = await User.findById(req.user.id).select('+password');
            if (!user) {
                return res.status(404).json({ message: 'Account not found' });
            }

            // A Google account has no password to compare against; sending it
            // through the reset flow would be equally wrong, so say what is
            // actually going on.
            if (!user.password) {
                return res.status(400).json({
                    message: 'This account signs in with Google and has no password to change.'
                });
            }

            if (!currentPassword) {
                return res.status(400).json({ message: 'Current password is required' });
            }

            // Counted like a sign-in, so a stolen session cannot guess here
            // without limit (services/signInLock.js).
            const matches = await signInLock.signInPasswordMatches(user, currentPassword);
            if (!matches) {
                return res.status(401).json({ message: `Current password is incorrect. ${signInLock.PAUSE_NOTE}` });
            }

            const salt = await bcrypt.genSalt(10);
            user.password = await bcrypt.hash(newPassword, salt);
            // Every other session ends with the old password; this one gets
            // a fresh token from the client signing in again.
            user.tokenVersion = (user.tokenVersion || 0) + 1;
            forgetSession(user._id);
            // Any reset link already in their inbox stops working now.
            user.passwordResetTokenHash = null;
            user.passwordResetExpiresAt = null;
            user.passwordChangedAt = new Date();
            await user.save();

            return res.status(200).json({ message: 'Password changed' });
        } catch (error) {
            console.error('changePassword error:', error);
            return res.status(500).json({ message: 'Could not change password', error: error.message });
        }
    },

    // POST /user/google-login - Verify Google ID token and login or create user
    googleLoginUser: async (req, res) => {
        try {
            const { idToken } = req.body || {};
            if (!idToken) {
                return res.status(400).json({ message: 'idToken is required' });
            }

            const clientId = process.env.GOOGLE_CLIENT_ID;
            if (!clientId) {
                return res.status(500).json({ message: 'Server misconfiguration: missing GOOGLE_CLIENT_ID' });
            }

            const client = new OAuth2Client(clientId);
            const ticket = await client.verifyIdToken({ idToken, audience: clientId });
            const payload = ticket.getPayload();
            if (!payload) {
                return res.status(401).json({ message: 'Invalid Google token' });
            }

            const {
                sub: googleId,
                email,
                given_name: givenName,
                family_name: familyName,
                picture,
                email_verified: emailVerified,
            } = payload;

            if (!email || !emailVerified) {
                return res.status(401).json({ message: 'Unverified Google account' });
            }

            const normalizedEmail = String(email).toLowerCase().trim();

            // Upsert user by email
            let user = await User.findOne({ email: normalizedEmail });
            if (!user) {
                // A first Google sign-in creates a member; the gym's plan may
                // cap how many it can hold (worded as the sign-up form words it).
                const limit = await checkLimit('members');
                if (!limit.ok) return res.status(403).json({ ...SIGNUPS_CLOSED });

                user = await User.create({
                    firstName: givenName || 'Google',
                    lastName: familyName || 'User',
                    email: normalizedEmail,
                    password: null,
                    provider: 'google',
                    googleId: googleId || null,
                    avatarUrl: picture || null,
                    // Google has checked the address.
                    emailVerified: true,
                });
                await assignMemberCode(user);
                afterResponse(() => notify.memberWelcome(user, { viaGoogle: true }), 'welcome email');
            } else {
                user = await linkGoogleAccount(user, { googleId, picture });
            }

            if (user.isActive === false) {
                return res.status(403).json({ message: 'This account has been deactivated.' });
            }

            // The same { requires2fa, challengeId } answer POST /user/login
            // gives; the code goes to POST /user/login/2fa.
            const step = await twoFactorStep(user);
            if (step) return res.status(step.status).json(step.body);

            // Issue JWT
            const payloadJwt = {
                id: user._id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
                tid: currentTenantId(),
                tv: user.tokenVersion || 0,
            };
            const secret = process.env.JWT_SECRET;
            if (!secret) {
                return res.status(500).json({ message: 'Server misconfiguration: missing JWT secret' });
            }
            const token = jwt.sign(payloadJwt, secret, { expiresIn: SESSION_TTL });

            user.lastLogin = new Date();
            await user.save();

            return res.status(200).json({ message: 'Login successful', token, data: publicUserView(user) });
        } catch (error) {
            console.error('Google login error:', error);
            return res.status(400).json({ message: 'Error during Google login', error: error.message });
        }
    },

    // PUT /update/user - a member edits their own profile
    //
    // { firstName?, lastName?, email?, phone?, dateOfBirth?, gender?,
    //   avatarUrl?, goals?, currentPassword? }
    //
    // `currentPassword` is needed when, and only when, the request changes
    // or removes the email address: that address is where a password reset
    // goes, so whoever can change it owns the account. Without it the
    // answer is a 400 with `code` PASSWORD_REQUIRED, PASSWORD_INCORRECT or
    // PASSWORD_NOT_SET (services/passwordCheck.js) and nothing is saved.
    // The old address is told, and the new one is sent a link to confirm it.
    updateUser: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);
            
            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }
            
            const userData = req.body || {};

            // Only the fields a member may change about themselves. Anything
            // else -- role, token version, staff notes, plan limits -- is not
            // theirs to set, however the request is shaped.
            const MEMBER_EDITABLE = ['firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'gender', 'avatarUrl', 'goals'];
            const safeUpdates = {};
            for (const key of MEMBER_EDITABLE) {
                if (userData[key] !== undefined) safeUpdates[key] = userData[key];
            }
            if (typeof safeUpdates.email === 'string') safeUpdates.email = safeUpdates.email.toLowerCase().trim();

            // What the request does to the address: nothing (not sent, or
            // the one already on the account), removes it, or changes it.
            //
            // An empty box is "remove my email". The model reads '' as no
            // email at all, so a $set of it quietly kept the old address while
            // answering "updated"; it is an $unset, for an account that may
            // go without one (emailRemovalProblem).
            let removedEmail = false;
            let changedEmail = false;
            let previousEmail = null;
            if (safeUpdates.email !== undefined) {
                const me = await User.findById(currentUser.id).select('email role employment.isStaff twoFactor.enabled provider googleId password').lean();
                if (!me) return res.status(404).json({ message: 'User not found' });

                if (safeUpdates.email === '' || safeUpdates.email === null) {
                    delete safeUpdates.email;
                    if (me.email) {
                        const problem = emailRemovalProblem(me);
                        if (problem) return res.status(409).json({ message: problem });
                        removedEmail = true;
                    }
                } else if (safeUpdates.email !== me.email) {
                    if (!verification.looksLikeEmail(safeUpdates.email)) {
                        return res.status(400).json({ message: 'Please provide a valid email address' });
                    }
                    changedEmail = true;
                }

                if (changedEmail || removedEmail) {
                    const refusal = await currentPasswordRefusal(me, userData.currentPassword, {
                        toDo: removedEmail ? 'remove your email address' : 'change your email address'
                    });
                    if (refusal) return res.status(400).json(refusal);
                    previousEmail = me.email || null;
                }
            }
            if (!Object.keys(safeUpdates).length && !removedEmail) {
                return res.status(400).json({ message: 'Nothing to update' });
            }
            const update = {};
            if (Object.keys(safeUpdates).length) update.$set = { ...safeUpdates };
            if (removedEmail) update.$unset = { email: 1 };
            if (changedEmail || removedEmail) {
                // A new address is nobody's until its owner says so: it is
                // sent a link, and claims no guest order before that
                // (services/emailVerification.js). Links already out -- a
                // reset, a confirmation -- went to the old address, and stop
                // working with it.
                update.$set = {
                    ...update.$set,
                    ...(changedEmail ? { emailVerified: false } : {}),
                    emailVerifyTokenHash: null,
                    emailVerifyExpiresAt: null,
                    passwordResetTokenHash: null,
                    passwordResetExpiresAt: null
                };
            }
            
            const updatedUser = await User.findByIdAndUpdate(
                currentUser.id,
                update,
                { new: true, runValidators: true }
            );
            
            if (!updatedUser) {
                return res.status(404).json({ message: 'User not found' });
            }

            if (changedEmail) {
                afterResponse(() => verification.sendLink(updatedUser, { origin: verification.apiOrigin(req) }), 'confirmation email');
            }
            // The address it was is told: if this was not its owner, that
            // message is how they find out.
            if (previousEmail) {
                afterResponse(() => verification.sendChangeNotice(previousEmail, updatedUser, { removed: removedEmail }), 'email change notice');
            }

            // Remove sensitive data from response
            let message = 'User updated successfully';
            if (removedEmail) {
                message = `Your email address was removed. Sign in with your username${updatedUser.username ? `, ${updatedUser.username},` : ''} from now on.`;
            } else if (changedEmail) {
                message = `Saved. We are sending a link to ${updatedUser.email}: open it to confirm the address is yours.`;
            }
            res.status(200).json({ message, data: publicUserView(updatedUser) });
        } catch (error) {
            // Somebody else's address: said as the sign-up form says it.
            if (error && error.code === 11000) {
                return res.status(409).json({ message: duplicateMessage(error) });
            }
            console.error('Update user error:', error);
            res.status(400).json({ 
                message: 'Error updating user', 
                error: error.message 
            });
        }
    },

    // DELETE /user - Delete one's own account
    deleteUser: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            // The photo and the uploaded documents ride along for
            // releaseAccount, which removes the stored files with the
            // account; `documents` is select: false, so it is asked for.
            const user = await User.findById(currentUser.id).select('role isActive avatarUrl +documents').lean();
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            // The last administrator cannot remove themselves: nobody would be
            // left who could hand the role out again.
            if (user.role === guards.ADMIN_SLUG && user.isActive !== false && (await activeAdminCount()) <= 1) {
                return res.status(403).json({
                    message: 'You are the last active administrator. Promote someone else before deleting this account.'
                });
            }

            const billing = await subscriptionsBlockDeletion(currentUser.id, { self: true, by: currentUser.id });
            if (billing) return res.status(409).json(billing);

            await User.findByIdAndDelete(currentUser.id);
            await releaseAccount(user);
            res.status(200).json({ message: 'User deleted successfully', id: currentUser.id });
        } catch (error) {
            res.status(400).json({ message: 'Error deleting user', error: error.message });
        }
    },
    getUserDetailForProfile: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);
            
            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }
            
            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            // The same view every sign-in returns: no credentials, and none
            // of the staff-only notes, which are about the member, not for
            // them (services/userView.js).
            res.status(200).json({
                message: 'User details retrieved successfully',
                data: publicUserView(user)
            });
        } catch (error) {
            console.error('Get user details error:', error);
            res.status(400).json({ 
                message: 'Error getting user details', 
                error: error.message 
            });
        }
    },
    getAllUsers: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);
            
            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }
            
            // Pagination and search are OPT-IN, and that is deliberate.
            //
            // This endpoint used to be an unbounded User.find(), which is a
            // problem at any real membership size. But two screens already
            // call it expecting the whole list back -- the Users table and the
            // member picker on Package Orders -- and quietly starting to
            // return only the first page would make members vanish from both
            // with no error to explain it. So the default is unchanged, and a
            // caller that passes `page` or `limit` gets a page instead.
            const { search, role, status } = req.query;
            const wantsPage = req.query.page !== undefined || req.query.limit !== undefined;

            const filter = {};

            if (search && String(search).trim()) {
                // Escaped: a member searching for "a.b" must not have the dot
                // treated as "any character", and a stray "(" must not throw.
                const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const rx = new RegExp(escaped, 'i');
                filter.$or = [
                    { firstName: rx },
                    { lastName: rx },
                    { email: rx },
                    { phone: rx },
                    { memberCode: rx }
                ];
            }

            if (role) filter.role = String(role).toLowerCase().trim();
            if (status === 'active') filter.isActive = true;
            if (status === 'inactive') filter.isActive = false;

            // A projection rather than deleting the password afterwards: the
            // hash should not travel out of the database at all. The reset
            // fields are already `select: false`.
            const projection = '-password';

            if (!wantsPage) {
                const users = await User.find(filter).select(projection).lean();
                return res.status(200).json({
                    message: 'Users details retrieved successfully',
                    data: users,
                    total: users.length
                });
            }

            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));

            const [users, total] = await Promise.all([
                User.find(filter)
                    .select(projection)
                    .sort({ createdAt: -1 })
                    .skip((page - 1) * limit)
                    .limit(limit)
                    .lean(),
                User.countDocuments(filter)
            ]);

            res.status(200).json({
                message: 'Users details retrieved successfully',
                data: users,
                total,
                pagination: {
                    page,
                    limit,
                    total,
                    pages: Math.max(1, Math.ceil(total / limit))
                }
            });
        } catch (error) {
            console.error('Get user details error:', error);
            res.status(400).json({ 
                message: 'Error getting user details', 
                error: error.message 
            });
        }
    },

    // PUT /update/status/:id - Update a user's active status by ID
    updateUserStatusById: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { id } = req.params;
            const { isActive } = req.body;
            if (typeof isActive !== 'boolean') {
                return res.status(400).json({ message: 'isActive must be a boolean' });
            }

            const target = await User.findById(id).select('role isActive').lean();
            if (!target) {
                return res.status(404).json({ message: 'User not found' });
            }

            // Nobody switches themselves off, only an admin switches an admin
            // off, nobody switches off an account that reaches further than
            // their own, and the last active admin stays on
            // (services/roleGuards.js).
            const refusal = guards.statusChangeProblem({
                actorId: currentUser.id,
                actorRole: actorRole(req, currentUser),
                actorPermissions: await permissionsFor(actorRole(req, currentUser)),
                target,
                targetPermissions: await permissionsFor(target.role),
                isActive,
                activeAdmins: target.role === guards.ADMIN_SLUG ? await activeAdminCount() : null
            });
            if (refusal) return res.status(403).json({ message: refusal });

            const updated = await User.findByIdAndUpdate(
                id,
                { $set: { isActive } },
                { new: true }
            );

            if (!updated) {
                return res.status(404).json({ message: 'User not found' });
            }

            // A deactivated account should be out within the request, not
            // when the session cache next expires.
            if (!isActive) forgetSession(updated._id);

            const { password: _pw, ...safe } = updated.toObject();
            return res.status(200).json({ message: 'Status updated successfully', data: safe });
        } catch (error) {
            console.error('Update user status error:', error);
            return res.status(400).json({ message: 'Error updating user status', error: error.message });
        }
    },

    // PUT /update/role/:id - Update a user's role by ID
    updateUserRoleById: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { id } = req.params;
            const { role } = req.body;

            // Roles are documents now, not a hardcoded list, so the check is
            // "does this role exist and is it live" rather than "is it one of
            // these three". See src/models/roleModel.js.
            const Role = require('../models/roleModel');
            const { ensureDefaultRoles } = require('../services/roleService');
            await ensureDefaultRoles();

            const target = await Role.findOne({ slug: String(role || '').toLowerCase().trim(), isActive: true });
            if (!target) {
                const available = await Role.find({ isActive: true }).select('slug').lean();
                return res.status(400).json({
                    message: `Unknown role. Available roles: ${available.map((r) => r.slug).join(', ')}`
                });
            }

            // Nobody changes their own role; only an administrator grants or
            // revokes the administrator role; nobody moves an account out of
            // or into a role that reaches further than their own (or they
            // could demote the manager, set the password, and restore the
            // role); and losing the last active administrator would leave
            // nobody able to hand the role back out (services/roleGuards.js).
            const current = await User.findById(id).select('role isActive employment.isStaff').lean();
            if (!current) {
                return res.status(404).json({ message: 'User not found' });
            }
            const refusal = guards.roleChangeProblem({
                actorId: currentUser.id,
                actorRole: actorRole(req, currentUser),
                actorPermissions: await permissionsFor(actorRole(req, currentUser)),
                target: current,
                currentPermissions: await permissionsFor(current.role),
                nextRole: target.slug,
                nextPermissions: await permissionsFor(target.slug),
                activeAdmins: current.role === guards.ADMIN_SLUG ? await activeAdminCount() : null
            });
            if (refusal) return res.status(403).json({ message: refusal });

            // A staff role brings employment with it; a member role ends it.
            // Without this the roster and the sidebar would disagree about who
            // works here after a promotion from the Users tab.
            const employmentPatch = target.isStaff
                ? { 'employment.isStaff': true, 'employment.endedAt': null }
                : { 'employment.isStaff': false };

            // A new role ends the account's sessions. A token carries the
            // role it was signed in with, and not every check re-reads the
            // live one, so a demoted manager must not keep a token saying
            // "manager" for the weeks it has left to run.
            const roleChanges = current.role !== target.slug
                || !!(current.employment && current.employment.isStaff) !== !!target.isStaff;

            // Staff are sent a sign-in code by email once the gym requires
            // two-factor, so a member with no address stays a member until
            // they add one (services/twoFactorService.js needsEmail).
            const twoFactor = require('../services/twoFactorService');
            if (roleChanges
                && twoFactor.needsEmail({ role: target.slug, employment: { isStaff: !!target.isStaff } })
                && !(await User.exists({ _id: id, email: { $type: 'string' } }))) {
                return res.status(409).json({ message: twoFactor.STAFF_NEED_EMAIL });
            }

            const change = { $set: { role: target.slug, ...employmentPatch } };
            if (roleChanges) change.$inc = { tokenVersion: 1 };

            const updated = await User.findByIdAndUpdate(
                id,
                change,
                { new: true, runValidators: true }
            );

            if (!updated) {
                return res.status(404).json({ message: 'User not found' });
            }
            if (roleChanges) forgetSession(updated._id);

            const { password: _pw, ...safe } = updated.toObject();
            return res.status(200).json({ message: 'Role updated successfully', data: safe });
        } catch (error) {
            console.error('Update user role error:', error);
            return res.status(400).json({ message: 'Error updating user role', error: error.message });
        }
    },

    // DELETE /delete/:id - Delete a user by ID
    deleteUserById: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { id } = req.params;
            const target = await User.findById(id).select('role isActive').lean();
            if (!target) {
                return res.status(404).json({ message: 'User not found' });
            }

            // Nobody deletes themselves from here, only an admin deletes an
            // admin, nobody deletes an account that reaches further than
            // their own, and the last active admin stays
            // (services/roleGuards.js).
            const refusal = guards.deleteProblem({
                actorId: currentUser.id,
                actorRole: actorRole(req, currentUser),
                actorPermissions: await permissionsFor(actorRole(req, currentUser)),
                target,
                targetPermissions: await permissionsFor(target.role),
                activeAdmins: target.role === guards.ADMIN_SLUG ? await activeAdminCount() : null
            });
            if (refusal) return res.status(403).json({ message: refusal });

            const billing = await subscriptionsBlockDeletion(id, { self: false, by: currentUser.id });
            if (billing) return res.status(409).json(billing);

            // With the uploaded documents (select: false), so releaseAccount
            // can remove the stored files along with the account.
            const deleted = await User.findByIdAndDelete(id).select('+documents');
            if (!deleted) {
                return res.status(404).json({ message: 'User not found' });
            }
            await releaseAccount(deleted);

            return res.status(200).json({ message: 'User deleted successfully', id });
        } catch (error) {
            console.error('Delete user error:', error);
            return res.status(400).json({ message: 'Error deleting user', error: error.message });
        }
    },

    // GET /user/addresses - Get all user addresses
    getUserAddresses: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const user = await User.findById(currentUser.id).select('addresses');
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            return res.status(200).json({
                success: true,
                message: 'Addresses retrieved successfully',
                data: user.addresses || []
            });
        } catch (error) {
            console.error('Get addresses error:', error);
            return res.status(400).json({ message: 'Error getting addresses', error: error.message });
        }
    },

    // POST /user/addresses - Add a new address
    addUserAddress: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const addressData = req.body;
            const user = await User.findById(currentUser.id);

            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            // Check if we already have 2 addresses
            if (user.addresses && user.addresses.length >= 2) {
                return res.status(400).json({ message: 'Maximum 2 addresses allowed. Please update existing addresses.' });
            }

            // Set label based on existing addresses
            if (!user.addresses || user.addresses.length === 0) {
                addressData.label = 'primary';
                addressData.isDefault = true;
            } else {
                addressData.label = 'secondary';
                addressData.isDefault = false;
            }

            user.addresses.push(addressData);
            await user.save();

            return res.status(201).json({
                success: true,
                message: 'Address added successfully',
                data: user.addresses
            });
        } catch (error) {
            console.error('Add address error:', error);
            return res.status(400).json({ message: 'Error adding address', error: error.message });
        }
    },

    // PUT /user/addresses/:addressId - Update an address
    updateUserAddress: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { addressId } = req.params;
            const addressData = req.body;

            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            const addressIndex = user.addresses.findIndex(addr => addr._id.toString() === addressId);
            if (addressIndex === -1) {
                return res.status(404).json({ message: 'Address not found' });
            }

            // Preserve label and update other fields
            const currentLabel = user.addresses[addressIndex].label;
            user.addresses[addressIndex] = { ...user.addresses[addressIndex].toObject(), ...addressData, label: currentLabel };
            await user.save();

            return res.status(200).json({
                success: true,
                message: 'Address updated successfully',
                data: user.addresses
            });
        } catch (error) {
            console.error('Update address error:', error);
            return res.status(400).json({ message: 'Error updating address', error: error.message });
        }
    },

    // DELETE /user/addresses/:addressId - Delete an address
    deleteUserAddress: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { addressId } = req.params;

            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            const addressIndex = user.addresses.findIndex(addr => addr._id.toString() === addressId);
            if (addressIndex === -1) {
                return res.status(404).json({ message: 'Address not found' });
            }

            user.addresses.splice(addressIndex, 1);

            // If we deleted primary and still have addresses, make the first one primary
            if (user.addresses.length > 0 && !user.addresses.some(a => a.label === 'primary')) {
                user.addresses[0].label = 'primary';
                user.addresses[0].isDefault = true;
            }

            await user.save();

            return res.status(200).json({
                success: true,
                message: 'Address deleted successfully',
                data: user.addresses
            });
        } catch (error) {
            console.error('Delete address error:', error);
            return res.status(400).json({ message: 'Error deleting address', error: error.message });
        }
    },

    // PUT /user/addresses/:addressId/default - Set an address as default
    setDefaultAddress: async (req, res) => {
        try {
            const token = req.headers.authorization;
            const currentUser = getUserFromToken(token);

            if (!currentUser) {
                return res.status(401).json({ message: 'Invalid or expired token' });
            }

            const { addressId } = req.params;

            const user = await User.findById(currentUser.id);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }

            const addressIndex = user.addresses.findIndex(addr => addr._id.toString() === addressId);
            if (addressIndex === -1) {
                return res.status(404).json({ message: 'Address not found' });
            }

            // Reset all addresses to non-default and secondary
            user.addresses.forEach((addr, idx) => {
                addr.isDefault = idx === addressIndex;
                addr.label = idx === addressIndex ? 'primary' : 'secondary';
            });

            await user.save();

            return res.status(200).json({
                success: true,
                message: 'Default address updated successfully',
                data: user.addresses
            });
        } catch (error) {
            console.error('Set default address error:', error);
            return res.status(400).json({ message: 'Error setting default address', error: error.message });
        }
    },
};

module.exports = userController;
// For screens that create an account as one step of something larger.
module.exports.createMemberAccount = createMemberAccount;
// ...and take it back out again when the larger thing fails.
module.exports.releaseAccount = releaseAccount;
// For the unit tests: the two emails built in this file.
module.exports.emailTemplates = { welcomeEmailHtml, passwordResetEmailHtml };
