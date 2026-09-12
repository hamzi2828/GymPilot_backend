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
const { gymSiteName } = require('../services/gymName');

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
    forgetSession(id);
}

/** Generates a readable but strong temporary password. */
function generatePassword(length = 14) {
  // Ambiguous glyphs (0/O, 1/l/I) omitted so the password survives being read
  // out of an email and retyped.
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

function welcomeEmailHtml({ firstName, email, username, password, siteName, loginUrl }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b">
    <h2 style="margin:0 0 16px;font-size:20px">Welcome to ${siteName}, ${firstName}</h2>
    <p style="margin:0 0 16px;line-height:1.6">An account has been created for you. Use these details to sign in:</p>
    <table style="width:100%;border-collapse:collapse;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;margin-bottom:16px">
      <tr><td style="padding:12px 16px;border-bottom:1px solid #e4e4e7;color:#71717a;font-size:13px">Email</td>
          <td style="padding:12px 16px;border-bottom:1px solid #e4e4e7;font-weight:600">${email}</td></tr>
      ${username ? `<tr><td style="padding:12px 16px;border-bottom:1px solid #e4e4e7;color:#71717a;font-size:13px">Username <span style="color:#a1a1aa">(phone app)</span></td>
          <td style="padding:12px 16px;border-bottom:1px solid #e4e4e7;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${username}</td></tr>` : ''}
      <tr><td style="padding:12px 16px;color:#71717a;font-size:13px">Temporary password</td>
          <td style="padding:12px 16px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${password}</td></tr>
    </table>
    <p style="margin:0 0 20px;line-height:1.6">Please change this password after your first sign-in.${username ? ' On the GymPilot phone app, sign in with your username and the same password.' : ''}</p>
    <a href="${loginUrl}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Sign in</a>
    <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa">If you were not expecting this email, you can ignore it.</p>
  </div>`;
}

function passwordResetEmailHtml({ firstName, siteName, resetUrl, validMinutes }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b">
    <h2 style="margin:0 0 16px;font-size:20px">Reset your ${siteName} password</h2>
    <p style="margin:0 0 16px;line-height:1.6">Hi ${firstName}, we received a request to reset the password on your account. Click the button below to choose a new one.</p>
    <a href="${resetUrl}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Choose a new password</a>
    <p style="margin:20px 0 0;line-height:1.6;font-size:13px;color:#71717a">This link is valid for ${validMinutes} minutes and can only be used once.</p>
    <p style="margin:16px 0 0;line-height:1.6;font-size:13px;color:#71717a">If the button does not work, paste this into your browser:<br>
      <span style="word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px">${resetUrl}</span></p>
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

// Minimum that is worth enforcing. Deliberately a length rule and nothing
// else: composition rules push people towards "Password1!" and no further.
const MIN_PASSWORD_LENGTH = 8;

function passwordProblem(password) {
  if (!password || typeof password !== 'string') return 'A new password is required';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > 200) return 'Password is too long';
  return null;
}

const userController = {


    // POST /admin/users - Admin creates a user and emails them their password
    adminCreateUser: async (req, res) => {
        try {
            const { firstName, lastName, email, role, phone } = req.body;

            if (!firstName || !lastName || !email) {
                return res.status(400).json({ message: 'First name, last name and email are required' });
            }

            const normalisedEmail = String(email).toLowerCase().trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
                return res.status(400).json({ message: 'Please provide a valid email address' });
            }

            const existing = await User.findOne({ email: normalisedEmail });
            if (existing) {
                return res.status(409).json({ message: 'Email already in use' });
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

            // A manager with `users: manage` must not be able to mint an
            // administrator.
            const refusal = guards.createRoleProblem({ actorRole: actorRole(req), role: assignedRole });
            if (refusal) return res.status(403).json({ message: refusal });

            // The gym's platform plan may cap how many accounts it can hold.
            const limit = await checkLimit(requestedRole && requestedRole.isStaff ? 'staff' : 'members');
            if (!limit.ok) return res.status(403).json({ message: limit.message, code: limit.code });

            // Generated server-side so a plaintext password is never accepted
            // over the wire or persisted anywhere but the outbound email.
            const password = generatePassword();
            const salt = await bcrypt.genSalt(10);
            const hashed = await bcrypt.hash(password, salt);

            const user = await User.create({
                firstName: String(firstName).trim(),
                lastName: String(lastName).trim(),
                email: normalisedEmail,
                password: hashed,
                role: assignedRole,
                phone: phone ? String(phone).trim() : null,
                // Creating someone straight into a staff role should make them
                // staff, or they would be invisible on the Staff tab that
                // manages their payroll and roster.
                employment: { isStaff: !!(requestedRole && requestedRole.isStaff) },
            });

            // The account exists regardless of whether the email lands, so a
            // send failure is reported rather than failing the whole request.
            let emailed = false;
            let emailError = null;
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

            return res.status(201).json({
                message: emailed
                    ? 'User created and credentials emailed'
                    : 'User created, but the credentials email could not be sent',
                emailed,
                emailError,
                data: publicUserView(user),
            });
        } catch (error) {
            if (error && error.code === 11000) {
                return res.status(409).json({ message: 'Email already in use' });
            }
            return res.status(400).json({ message: 'Error creating user', error: error.message });
        }
    },

    // POST /admin/users/:id/username - Issue a fresh username
    //
    // For the rare case where a member does not want the one they were given,
    // or two members with the same name keep confusing each other. The old
    // username stops working immediately, so the member has to be told.
    regenerateUsername: async (req, res) => {
        try {
            const user = await User.findById(req.params.id);
            if (!user) return res.status(404).json({ message: 'User not found' });

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

            // Check if user already exists
            const existing = await User.findOne({ email: email.toLowerCase().trim() });
            if (existing) {
                return res.status(409).json({ message: 'Email already in use' });
            }

            // The gym's platform plan may cap how many members it can hold.
            const limit = await checkLimit('members');
            if (!limit.ok) return res.status(403).json({ message: limit.message, code: limit.code });

            // Hash password
            const salt = await bcrypt.genSalt(10);
            const hashed = await bcrypt.hash(password, salt);

            // Create user
            const user = await User.create({
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                email: email.toLowerCase().trim(),
                password: hashed,
            });

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
            // the sign-in. See platform/middleware/tenantFromPayload.js.
            const stateData = JSON.stringify({ returnUrl, platformType, tenant: currentTenantSlug() });
            const state = encodeURIComponent(stateData);
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
                return res.status(400).send(`Google OAuth error: ${error}`);
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

            // Parse state to get returnUrl and platformType
            let returnUrl = '/';
            try {
                const stateData = JSON.parse(decodeURIComponent(state || '{}'));
                returnUrl = stateData.returnUrl || '/';
            } catch (parseError) {
                // Fallback to treating state as just the returnUrl for backward compatibility
                returnUrl = decodeURIComponent(state || '/');
            }

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
                // sign-up form and the admin form make.
                const limit = await checkLimit('members');
                if (!limit.ok) return res.status(403).json({ message: limit.message, code: limit.code });

                user = await User.create({
                    firstName: givenName || 'Google',
                    lastName: familyName || 'User',
                    email: normalizedEmail,
                    password: null,
                    provider: 'google',
                    googleId: googleId || null,
                    avatarUrl: picture || null,
                });
            } else {
                const updates = {};
                if (!user.googleId && googleId) updates.googleId = googleId;
                if (user.provider !== 'google') updates.provider = 'google';
                if (picture && user.avatarUrl !== picture) updates.avatarUrl = picture;
                if (Object.keys(updates).length > 0) {
                    await User.updateOne({ _id: user._id }, { $set: updates });
                    user = await User.findById(user._id);
                }
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

            // The token lands on the sign-in page, which stores it and then
            // sends the person on to `redirect` -- the same param the
            // password form honours -- rather than being sprayed onto
            // whichever page they started from. Only a same-site path is
            // carried; anything else falls back to the homepage.
            const params = new URLSearchParams({ googleToken: token });
            const safeReturn = typeof returnUrl === 'string' && returnUrl.startsWith('/') && !returnUrl.startsWith('//') && returnUrl !== '/'
                ? returnUrl
                : '';
            if (safeReturn) params.set('redirect', safeReturn);
            return res.redirect(`${frontendOrigin}/authentication?${params.toString()}`);
        } catch (error) {
            console.error('googleOAuthCallback error:', error);
            return res.status(400).send('Failed to complete Google OAuth');
        }
    },

    // POST /user/login - Authenticate user and return JWT
    loginUser: async (req, res) => {
        try {
            const { email, password } = req.body;
            const remember = wantsRemember(req.body);
            if (!email || !password) {
                return res.status(400).json({ message: 'Email and password are required' });
            }

            const user = await User.findOne({ email: String(email).toLowerCase().trim() });
            if (!user) {
                return res.status(401).json({ message: 'Invalid credentials' });
            }

            // Prevent password login for accounts created via Google
            if (!user.password) {
                return res.status(401).json({ message: 'This account uses Google login. Please sign in with Google.' });
            }

            const match = await bcrypt.compare(password, user.password);
            if (!match) {
                return res.status(401).json({ message: 'Invalid credentials' });
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

            // No account, a deactivated one, or a Google account with no
            // password to reset: all stop here, all look identical from
            // outside.
            if (!user || user.isActive === false || !user.password) {
                return res.status(200).json(genericResponse);
            }

            // Raw token goes in the email; only its hash is stored.
            const token = crypto.randomBytes(32).toString('hex');
            user.passwordResetTokenHash = hashResetToken(token);
            user.passwordResetExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
            await user.save();

            const siteName = await gymSiteName();
            const frontend = tenantOrigin();
            const resetUrl =
                `${frontend}/authentication?mode=reset&token=${encodeURIComponent(token)}` +
                `&email=${encodeURIComponent(normalisedEmail)}`;

            const result = await sendEmail(
                normalisedEmail,
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
                console.error('[auth] reset email failed for', normalisedEmail, '-', result.error);
                user.passwordResetTokenHash = null;
                user.passwordResetExpiresAt = null;
                await user.save();
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
            // Every other session ends with the old password.
            user.tokenVersion = (user.tokenVersion || 0) + 1;
            forgetSession(user._id);

            // Single use: the token is spent whether or not the same person
            // clicks the link again.
            user.passwordResetTokenHash = null;
            user.passwordResetExpiresAt = null;
            user.passwordChangedAt = new Date();
            await user.save();

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

            const matches = await bcrypt.compare(currentPassword, user.password);
            if (!matches) {
                return res.status(401).json({ message: 'Current password is incorrect' });
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
                // cap how many it can hold.
                const limit = await checkLimit('members');
                if (!limit.ok) return res.status(403).json({ message: limit.message, code: limit.code });

                user = await User.create({
                    firstName: givenName || 'Google',
                    lastName: familyName || 'User',
                    email: normalizedEmail,
                    password: null,
                    provider: 'google',
                    googleId: googleId || null,
                    avatarUrl: picture || null,
                });
            } else {
                // Update linkage if necessary
                const updates = {};
                if (!user.googleId && googleId) updates.googleId = googleId;
                if (user.provider !== 'google') updates.provider = 'google';
                if (picture && user.avatarUrl !== picture) updates.avatarUrl = picture;
                if (Object.keys(updates).length > 0) {
                    await User.updateOne({ _id: user._id }, { $set: updates });
                    user = await User.findById(user._id);
                }
            }

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

    // PUT /user - Update an existing user
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
            if (!Object.keys(safeUpdates).length) {
                return res.status(400).json({ message: 'Nothing to update' });
            }
            
            const updatedUser = await User.findByIdAndUpdate(
                currentUser.id,
                { $set: safeUpdates },
                { new: true, runValidators: true }
            );
            
            if (!updatedUser) {
                return res.status(404).json({ message: 'User not found' });
            }

            // Remove sensitive data from response
            res.status(200).json({
                message: 'User updated successfully',
                data: publicUserView(updatedUser)
            });
        } catch (error) {
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

            const user = await User.findById(currentUser.id).select('role isActive').lean();
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
            // off, and the last active admin stays on (services/roleGuards.js).
            const refusal = guards.statusChangeProblem({
                actorId: currentUser.id,
                actorRole: actorRole(req, currentUser),
                target,
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
            // revokes the administrator role; and losing the last active
            // administrator would leave nobody able to hand the role back out
            // (services/roleGuards.js).
            const current = await User.findById(id).select('role isActive').lean();
            if (!current) {
                return res.status(404).json({ message: 'User not found' });
            }
            const refusal = guards.roleChangeProblem({
                actorId: currentUser.id,
                actorRole: actorRole(req, currentUser),
                target: current,
                nextRole: target.slug,
                activeAdmins: current.role === guards.ADMIN_SLUG ? await activeAdminCount() : null
            });
            if (refusal) return res.status(403).json({ message: refusal });

            // A staff role brings employment with it; a member role ends it.
            // Without this the roster and the sidebar would disagree about who
            // works here after a promotion from the Users tab.
            const employmentPatch = target.isStaff
                ? { 'employment.isStaff': true, 'employment.endedAt': null }
                : { 'employment.isStaff': false };

            const updated = await User.findByIdAndUpdate(
                id,
                { $set: { role: target.slug, ...employmentPatch } },
                { new: true, runValidators: true }
            );

            if (!updated) {
                return res.status(404).json({ message: 'User not found' });
            }

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
            // admin, and the last active admin stays (services/roleGuards.js).
            const refusal = guards.deleteProblem({
                actorId: currentUser.id,
                actorRole: actorRole(req, currentUser),
                target,
                activeAdmins: target.role === guards.ADMIN_SLUG ? await activeAdminCount() : null
            });
            if (refusal) return res.status(403).json({ message: refusal });

            const deleted = await User.findByIdAndDelete(id);
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
