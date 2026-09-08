// src/controller/mobileAuthController.js
//
// Sign-in for the GymPilot phone app.
//
// The website knows which gym it is from the domain it was opened on. The app
// does not: a member types the username and password their gym gave them and
// nothing else. So this route runs BEFORE the tenant gate, looks the username
// up in the platform-wide member directory to find the gym, steps into that
// gym's database, and only then checks the password.
//
// Everything after sign-in uses the gym's ordinary API: the app sends the
// token it gets here plus `X-Tenant-Slug`, which the tenant resolver already
// understands, and middleware/auth refuses a token whose `tid` does not match
// that gym.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Gym = require('../platform/models/gymModel');
const MemberDirectory = require('../platform/models/memberDirectoryModel');
const { runWithTenant, tenantContextFor } = require('../platform/tenantContext');
const { branding } = require('../services/branding');

// One message for "no such username" and "wrong password" alike: a member
// list is worth money to a competitor, and a login form that says which
// usernames exist hands one over.
const REJECTED = 'That username and password do not match.';

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

      const gym = await Gym.findById(entry.gymId);
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
          return { status: 403, body: { success: false, message: 'This account has been turned off. Please speak to your gym.' } };
        }

        // Same second step as the website. The app finishes it against the
        // gym's ordinary endpoint, sending the slug returned below.
        const twoFactor = require('../services/twoFactorService');
        if (await twoFactor.required(user)) {
          const challenge = await twoFactor.startChallenge(user);
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

        const secret = process.env.JWT_SECRET;
        if (!secret) return { status: 500, body: { success: false, message: 'Server misconfiguration: missing JWT secret' } };

        const token = jwt.sign(
          {
            id: user._id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            tid: String(gym._id),
            tv: user.tokenVersion || 0
          },
          secret,
          { expiresIn: '30d' } // a phone is not a shared computer
        );

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
      });

      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error('[mobile] login failed:', error);
      return res.status(500).json({ success: false, message: 'Could not sign you in right now. Please try again.' });
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

      const gym = await Gym.findOne({ slug });
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
  }
};
