// src/controller/mobileAuthController.js
//
// Sign-in for the GymPilot phone app.
//
// The website knows which gym it is from the domain it was opened on. The app
// does not: a member types the username and password their gym gave them and
// nothing else. So these routes run BEFORE the tenant gate, look the username
// up in the platform-wide member directory to find the gym, step into that
// gym's database, and only then check the password.
//
// Everything after sign-in uses the gym's ordinary API: the app sends the
// token it gets here plus `X-Tenant-Slug`, which the tenant resolver already
// understands, and middleware/auth refuses a token whose `tid` does not match
// that gym. The two exceptions live at the bottom of this file -- the push
// token routes -- because they are the app's own and nobody else's.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Gym = require('../platform/models/gymModel');
const MemberDirectory = require('../platform/models/memberDirectoryModel');
const { runWithTenant, tenantContextFor } = require('../platform/tenantContext');
const { branding } = require('../services/branding');
const { isExpoPushToken } = require('../services/messaging');
const { MEMBER_APP_CLAIM } = require('../middleware/auth');

// One message for "no such username" and "wrong password" alike: a member
// list is worth money to a competitor, and a login form that says which
// usernames exist hands one over.
const REJECTED = 'That username and password do not match.';
const EXPIRED_SIGN_IN = 'This sign-in has expired. Please sign in again.';
const TURNED_OFF = 'This account has been turned off. Please speak to your gym.';
// Same idea for the reset link: one answer whether or not the username exists.
const FORGOT_MESSAGE = 'If that username exists, we emailed a reset link.';
const NOT_INCLUDED = { success: false, code: 'MEMBER_APP_NOT_INCLUDED', message: 'Your gym has not enabled the member app yet.' };

// A phone is not a shared computer.
const TOKEN_TTL = '30d';

const PUSH_PLATFORMS = ['ios', 'android', 'web'];

function apiOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function safeUser(user) {
  return {
    id: String(user._id),
    username: user.username || '',
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone || '',
    role: user.role,
    avatarUrl: user.avatarUrl || '',
    dateOfBirth: user.dateOfBirth || null,
    isStaff: !!(user.employment && user.employment.isStaff)
  };
}

// The gym record with its connection string. `database.uri` is select:false
// so it never leaks into a response, but a gym on its own cluster cannot be
// reached without it; findByIdWithUri includes it. A gym model without that
// static (an older platform build) falls back to the plain lookup, which
// serves shared-cluster gyms exactly as before.
function gymById(id) {
  return typeof Gym.findByIdWithUri === 'function' ? Gym.findByIdWithUri(id) : Gym.findById(id).lean();
}

// Whether the gym pays for (or is given) the member app -- add-on slug
// `member-app`, decided by platform/entitlements. The module belongs to the
// platform team; should a build ship without it, sign-in is allowed and the
// gap is logged once rather than locking every gym's members out.
let entitlementsWarned = false;
async function memberAppEnabled(gym) {
  let entitlements = null;
  try {
    entitlements = require('../platform/entitlements');
  } catch (error) {
    if (!entitlementsWarned) {
      entitlementsWarned = true;
      console.warn('[mobile] platform/entitlements is not available; allowing the member app for every gym.', error.message);
    }
    return true;
  }
  if (typeof entitlements.gymHasAddon !== 'function') return true;
  return entitlements.gymHasAddon(gym, 'member-app');
}

/**
 * The same claims the website issues, with the app's longer lifetime -- and
 * `app`, which tells middleware/auth to keep checking the member-app add-on
 * for as long as the token lives, not just at sign-in.
 */
function issueToken(user, gym) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tid: String(gym._id),
      tv: user.tokenVersion || 0,
      app: MEMBER_APP_CLAIM
    },
    secret,
    { expiresIn: TOKEN_TTL }
  );
}

/**
 * The end of a successful sign-in, whichever route got there: the token,
 * the member, their gym and its look, all in one payload. Runs inside the
 * gym's tenant context.
 */
async function signedIn(user, gym, req) {
  const token = issueToken(user, gym);
  if (!token) return { status: 500, body: { success: false, message: 'Server misconfiguration: missing JWT secret' } };

  user.lastLogin = new Date();
  await user.save();

  return {
    status: 200,
    body: {
      success: true,
      token,
      user: safeUser(user),
      gym: { slug: gym.slug, name: gym.name },
      branding: await branding(apiOrigin(req))
    }
  };
}

/** A `res` that keeps the answer to itself, for calling one handler from another. */
function silentResponse() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.send = res.json;
  return res;
}

module.exports = {
  // POST /api/mobile/auth/login   { username, password }
  login: async (req, res) => {
    try {
      const username = String(req.body?.username || '').toLowerCase().trim();
      const password = String(req.body?.password || '');
      if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password are required.' });
      }

      const entry = await MemberDirectory.lookup(username);
      if (!entry) return res.status(401).json({ success: false, message: REJECTED });

      const gym = await gymById(entry.gymId);
      if (!gym) return res.status(401).json({ success: false, message: REJECTED });

      // A suspended gym, or one whose subscription lapsed, is closed to its
      // members too -- the same check the website gets from the tenant gate.
      const block = Gym.accessBlock(gym);
      if (block) return res.status(block.status).json({ success: false, message: block.message, code: block.code });

      const context = await tenantContextFor(gym);
      const result = await runWithTenant(context, async () => {
        const User = require('../models/user');
        const user = await User.findById(entry.userId);
        if (!user || !user.password) return { status: 401, body: { success: false, message: REJECTED } };
        if (!(await bcrypt.compare(password, user.password))) {
          return { status: 401, body: { success: false, message: REJECTED } };
        }
        if (user.isActive === false) {
          return { status: 403, body: { success: false, message: TURNED_OFF } };
        }

        // Only after the password: a gym without the add-on must not become
        // a way to learn which usernames exist at it.
        if (!(await memberAppEnabled(gym))) return { status: 403, body: NOT_INCLUDED };

        // Same second step as the website. The app finishes it against
        // /auth/login/2fa below, sending back the slug returned here.
        const twoFactor = require('../services/twoFactorService');
        if (await twoFactor.required(user)) {
          const challenge = await twoFactor.startChallenge(user);
          // No address to send a code to: a clear answer, not "try later".
          if (challenge.noEmail) return { status: 409, body: { success: false, message: twoFactor.NO_EMAIL_SIGN_IN } };
          if (!challenge.emailed) {
            return { status: 503, body: { success: false, message: 'We could not email your sign-in code. Please contact your gym.' } };
          }
          return {
            status: 200,
            body: {
              success: true,
              requires2fa: true,
              challengeId: challenge.challengeId,
              gym: { slug: gym.slug, name: gym.name },
              message: `We emailed a 6-digit code to ${twoFactor.maskEmail(user.email)}.`
            }
          };
        }

        return signedIn(user, gym, req);
      });

      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error('[mobile] login failed:', error);
      return res.status(500).json({ success: false, message: 'Could not sign you in right now. Please try again.' });
    }
  },

  // POST /api/mobile/auth/login/2fa   { challengeId, code, gym }
  //
  // The second step of the sign-in above. The app sends back the gym slug it
  // was given, which is what lets this route find the challenge: it lives in
  // that gym's database, on the account that started it. A wrong code counts
  // one attempt and emails nothing -- only a fresh sign-in sends a new code.
  verifyTwoFactor: async (req, res) => {
    try {
      const challengeId = String(req.body?.challengeId || '').trim();
      const code = String(req.body?.code || '').trim();
      const slug = String(req.body?.gym || '').toLowerCase().trim();
      if (!challengeId || !code || !slug) {
        return res.status(400).json({ success: false, message: 'Enter the 6-digit code from your email.' });
      }

      const gym = await Gym.findBySlug(slug);
      if (!gym) return res.status(401).json({ success: false, message: EXPIRED_SIGN_IN });
      const block = Gym.accessBlock(gym);
      if (block) return res.status(block.status).json({ success: false, message: block.message, code: block.code });

      const context = await tenantContextFor(gym);
      const result = await runWithTenant(context, async () => {
        const twoFactor = require('../services/twoFactorService');
        let user;
        try {
          // The same check the website's /user/login/2fa makes: single-use,
          // ten minutes, five tries.
          user = await twoFactor.verify(challengeId, code);
        } catch (error) {
          if (error.status) return { status: error.status, body: { success: false, message: error.message } };
          throw error;
        }
        if (user.isActive === false) return { status: 403, body: { success: false, message: TURNED_OFF } };
        if (!(await memberAppEnabled(gym))) return { status: 403, body: NOT_INCLUDED };

        return signedIn(user, gym, req);
      });

      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error('[mobile] 2fa failed:', error);
      return res.status(500).json({ success: false, message: 'Could not check that code right now. Please try again.' });
    }
  },

  // POST /api/mobile/auth/forgot   { username }
  //
  // Emails the same reset link the website's forgot-password form does; the
  // member finishes on the gym's website, where the link points. The answer
  // is the same whether or not the username exists, for the reason given
  // above REJECTED.
  forgot: async (req, res) => {
    const generic = { success: true, message: FORGOT_MESSAGE };
    try {
      const username = String(req.body?.username || '').toLowerCase().trim();
      if (!username) return res.status(400).json({ success: false, message: 'Username is required.' });

      const entry = await MemberDirectory.lookup(username);
      if (!entry) return res.status(200).json(generic);

      const gym = await gymById(entry.gymId);
      if (!gym || Gym.accessBlock(gym)) return res.status(200).json(generic);

      const context = await tenantContextFor(gym);
      await runWithTenant(context, async () => {
        const User = require('../models/user');
        const user = await User.findById(entry.userId).select('email').lean();
        if (!user || !user.email) return;

        // The website's own handler, called as a function inside the gym's
        // context: it stores the hashed token, builds the link from the
        // gym's registered domain and sends the email. Its reply is the same
        // generic 200 every time, so it is not needed; the app gets the
        // wording above instead.
        const { forgotPassword } = require('./userController');
        await forgotPassword({ body: { email: user.email } }, silentResponse());
      });

      return res.status(200).json(generic);
    } catch (error) {
      console.error('[mobile] forgot failed:', error);
      // Still generic: an error here must not become a way to probe usernames.
      return res.status(200).json(generic);
    }
  },

  // GET /api/mobile/branding?gym=<slug>
  //
  // Lets the app repaint itself on launch, before anyone signs in, when it
  // already remembers which gym it belongs to.
  branding: async (req, res) => {
    try {
      const slug = String(req.query.gym || '').toLowerCase().trim();
      if (!slug) return res.status(400).json({ success: false, message: 'A gym is required.' });

      const gym = await Gym.findBySlug(slug);
      if (!gym) return res.status(404).json({ success: false, message: 'No such gym.' });
      const block = Gym.accessBlock(gym);
      if (block) return res.status(block.status).json({ success: false, message: block.message, code: block.code });

      const context = await tenantContextFor(gym);
      const data = await runWithTenant(context, () => branding(apiOrigin(req)));
      return res.json({ success: true, data });
    } catch (error) {
      console.error('[mobile] branding failed:', error);
      return res.status(500).json({ success: false, message: 'Could not load the gym.' });
    }
  },

  // POST /api/mobile/push/register   { token, platform, deviceName }
  //
  // Behind resolveTenant + auth (see routes/mobileRoutes.js), so req.user is
  // the signed-in member and the model below is their gym's. One row per
  // token: a phone that re-registers on every launch updates its row, and a
  // phone handed to somebody else moves to their account.
  registerPush: async (req, res) => {
    try {
      const token = String(req.body?.token || '').trim();
      if (!isExpoPushToken(token)) {
        return res.status(400).json({ success: false, message: 'A valid Expo push token is required.' });
      }
      const platform = String(req.body?.platform || '').toLowerCase().trim();
      const deviceName = String(req.body?.deviceName || '').trim().slice(0, 120);

      const MobilePushToken = require('../models/mobilePushTokenModel');
      await MobilePushToken.findOneAndUpdate(
        { token },
        { $set: { userId: req.user.id, platform: PUSH_PLATFORMS.includes(platform) ? platform : 'unknown', deviceName } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      // One phone, one member. The unique index already keeps it to one row,
      // but a gym database whose indexes were never built could hold a copy
      // still pointing at whoever used the phone before.
      await MobilePushToken.deleteMany({ token, userId: { $ne: req.user.id } });
      return res.json({ success: true, message: 'This phone will receive notifications.' });
    } catch (error) {
      console.error('[mobile] push register failed:', error);
      return res.status(500).json({ success: false, message: 'Could not register this phone for notifications.' });
    }
  },

  // DELETE /api/mobile/push/register   { token }   + X-Tenant-Slug
  //
  // On sign-out. No sign-in needed: holding the Expo push token -- a long
  // random string only the phone and the gym's database know -- is the
  // proof. It has to work without one, because a sign-out is often the
  // server having already ended the session (30 days up, a password
  // change, "sign out everywhere", a deactivated account), and a phone
  // left registered keeps showing the last member's notifications to
  // whoever signs in next.
  //
  // The gym is found here rather than by resolveTenant, which turns away a
  // suspended or lapsed gym -- and "your gym is closed, sign out" is exactly
  // when a member is most likely to be doing this.
  unregisterPush: async (req, res) => {
    try {
      const token = String(req.body?.token || '').trim();
      if (!token) return res.status(400).json({ success: false, message: 'A push token is required.' });

      const headers = req.headers || {};
      const slug = String(headers['x-tenant-slug'] || req.body?.gym || '').toLowerCase().trim();
      if (!slug || !Gym.SLUG_PATTERN.test(slug)) {
        return res.status(400).json({ success: false, message: 'Say which gym this phone was registered with.' });
      }
      const gym = await Gym.findBySlug(slug);
      if (!gym) return res.status(404).json({ success: false, code: 'TENANT_NOT_FOUND', message: 'No such gym.' });

      const context = await tenantContextFor(gym);
      const removed = await runWithTenant(context, async () => {
        const MobilePushToken = require('../models/mobilePushTokenModel');
        const result = await MobilePushToken.deleteMany({ token });
        return result.deletedCount || 0;
      });
      return res.json({ success: true, message: 'Notifications are off for this phone.', removed });
    } catch (error) {
      console.error('[mobile] push unregister failed:', error);
      return res.status(500).json({ success: false, message: 'Could not remove this phone.' });
    }
  }
};

// For the unit tests: what a member-app token carries.
module.exports.issueToken = issueToken;
