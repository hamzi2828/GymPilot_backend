// src/platform/controllers/gymsController.js
//
// The platform panel's view of its customers: every gym, what it is on,
// whether it is being served, and the numbers from inside its database.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Gym = require('../models/gymModel');
const PlatformPlan = require('../models/platformPlanModel');
const { resolveAddons } = require('./addonsController');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const DemoRequest = require('../models/demoRequestModel');
const {
  ProvisioningError,
  provisionGym,
  replaceDomains,
  deleteGym,
  subscriptionFor
} = require('../provisioning');
const { collectGymStats } = require('../tenantStats');
const { runWithTenant, siteUrlFor, inviteSiteUrlFor } = require('../tenantContext');
const { invalidateTenantCache } = require('../middleware/resolveTenant');
const { invalidatePlanCache } = require('../planLimits');
const { sendOwnerInvite } = require('../ownerInvite');
const { syncStripeSubscription, changesPrice, SubscriptionSyncError } = require('../services/subscriptionSync');

const User = require('../../models/user');
const { ADMIN_SLUG } = require('../../services/roleService');

const MIN_PASSWORD_LENGTH = 8;
const PAGE_SIZE = 25;
const AUDIT_LIMIT = 200;

// What the panel keeps beside a subscription it re-writes: what Stripe
// knows about the gym, and which lifecycle emails already went.
const STRIPE_FIELDS = ['stripeCustomerId', 'stripeSubscriptionId', 'stripePriceSummary'];

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

function audit(req, action, gym, meta = null) {
  return PlatformAuditLog.record({
    actorId: req.superAdmin._id,
    actorEmail: req.superAdmin.email,
    action,
    gymId: gym ? gym._id : null,
    gymSlug: gym ? gym.slug : '',
    meta,
    ip: clientIp(req)
  });
}

function fail(res, error) {
  if (error instanceof ProvisioningError) {
    return res.status(error.status).json({ success: false, message: error.message, details: error.details });
  }
  if (error && error.name === 'ValidationError') {
    return res.status(400).json({ success: false, message: error.message });
  }
  if (error && error.code === 11000) {
    return res.status(409).json({ success: false, message: 'A gym with that slug already exists' });
  }
  console.error('[platform] gyms:', error);
  return res.status(500).json({ success: false, message: error.message || 'Request failed' });
}

// The only shape a gym leaves the API in: the connection string is dropped
// here whether or not the query selected it.
function publicGym(doc) {
  const gym = doc && doc.toObject ? doc.toObject() : { ...doc };
  if (gym.database) gym.database = { name: gym.database.name };
  gym.id = String(gym._id);
  gym.access_block = Gym.accessBlock(gym);
  // Where its website is: primary domain, else platform subdomain, else the
  // env fallback -- the same answer links in its emails get.
  gym.siteUrl = siteUrlFor(gym);
  return gym;
}

// With the connection string, so anything that enters the gym's database
// (stats, administrators, the owner's password) lands on its own cluster
// when it has one. Never sent onwards as-is: see publicGym.
async function loadGym(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Gym.findById(id).select('+database.uri');
}

/**
 * Marks the demo request a gym was set up from as converted and links it to
 * the gym, so the Demo requests page shows where it went. The gym already
 * exists by now, so a problem here is a warning, never a failure.
 *
 * @returns {Promise<{request: {id, status, gymId}|null, warning: string|null}>}
 */
async function markRequestConverted(requestId, gym, superAdmin) {
  if (!requestId) return { request: null, warning: null };
  const lost = 'The request this gym was set up from no longer exists, so it was not marked converted';
  if (!mongoose.Types.ObjectId.isValid(String(requestId))) return { request: null, warning: lost };
  try {
    const doc = await DemoRequest.findByIdAndUpdate(
      requestId,
      { $set: { status: 'converted', gymId: gym._id, convertedAt: new Date(), handledBy: superAdmin._id } },
      { new: true }
    );
    if (!doc) return { request: null, warning: lost };
    return { request: { id: String(doc._id), status: doc.status, gymId: String(gym._id) }, warning: null };
  } catch (error) {
    return { request: null, warning: `The request this gym was set up from could not be marked converted: ${error.message}` };
  }
}

module.exports = {
  // GET /api/platform/overview
  overview: async (req, res) => {
    try {
      const now = new Date();
      const in30 = new Date(now.getTime() + 30 * 86400000);

      const [total, active, suspended, bySubscription, expiringSoon, mrrRows] = await Promise.all([
        Gym.countDocuments({}),
        Gym.countDocuments({ status: 'active' }),
        Gym.countDocuments({ status: 'suspended' }),
        Gym.aggregate([{ $group: { _id: '$subscription.status', count: { $sum: 1 } } }]),
        Gym.countDocuments({
          status: 'active',
          'subscription.status': { $in: ['trialing', 'active'] },
          'subscription.currentPeriodEnd': { $ne: null, $gte: now, $lte: in30 }
        }),
        Gym.aggregate([
          { $match: { status: 'active', 'subscription.status': 'active' } },
          {
            $project: {
              currency: { $toUpper: { $ifNull: ['$subscription.currency', 'USD'] } },
              monthly: {
                $cond: [
                  { $eq: ['$subscription.billingCycle', 'yearly'] },
                  { $divide: [{ $ifNull: ['$subscription.amount', 0] }, 12] },
                  { $ifNull: ['$subscription.amount', 0] }
                ]
              }
            }
          },
          { $group: { _id: '$currency', mrr: { $sum: '$monthly' }, gyms: { $sum: 1 } } },
          { $sort: { mrr: -1 } }
        ])
      ]);

      const subscriptions = {};
      for (const row of bySubscription) subscriptions[row._id || 'unknown'] = row.count;

      // The gyms somebody should look at, for the panel's overview.
      const brief = (g) => ({
        id: String(g._id),
        name: g.name,
        slug: g.slug,
        plan: g.plan && g.plan.name ? g.plan.name : null,
        currentPeriodEnd: g.subscription && g.subscription.currentPeriodEnd
      });
      const [renewing, pastDue, suspendedGyms, newRequests] = await Promise.all([
        Gym.find({ status: 'active', 'subscription.status': { $in: ['trialing', 'active'] }, 'subscription.currentPeriodEnd': { $ne: null, $gte: now, $lte: in30 } })
          .sort({ 'subscription.currentPeriodEnd': 1 })
          .limit(10)
          .populate('plan', 'name')
          .lean(),
        Gym.find({ status: 'active', 'subscription.status': { $in: ['past_due', 'expired'] } }).sort({ 'subscription.currentPeriodEnd': 1 }).limit(10).populate('plan', 'name').lean(),
        Gym.find({ status: 'suspended' }).sort({ updatedAt: -1 }).limit(10).populate('plan', 'name').lean(),
        DemoRequest.countDocuments({ status: 'new' })
      ]);

      return res.json({
        success: true,
        data: {
          gyms: { total, active, suspended },
          subscriptions,
          expiring_within_30_days: expiringSoon,
          mrr: mrrRows.map((row) => ({ currency: row._id, amount: Math.round(row.mrr * 100) / 100, gyms: row.gyms })),
          attention: { renewing: renewing.map(brief), past_due: pastDue.map(brief), suspended: suspendedGyms.map(brief) },
          demo_requests_new: newRequests
        }
      });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/platform/gyms?search=&status=&subscription=&page=&withStats=1
  list: async (req, res) => {
    try {
      const { search, status, subscription } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const withStats = req.query.withStats === '1';

      const query = {};
      if (status && Gym.GYM_STATUSES.includes(status)) query.status = status;
      if (subscription && Gym.SUBSCRIPTION_STATUSES.includes(subscription)) query['subscription.status'] = subscription;
      if (search && String(search).trim()) {
        const term = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        query.$or = [{ name: term }, { slug: term }, { 'domains.host': term }, { 'owner.email': term }];
      }

      const [total, gyms] = await Promise.all([
        Gym.countDocuments(query),
        Gym.find(query)
          .select('+database.uri')
          .sort({ createdAt: -1 })
          .skip((page - 1) * PAGE_SIZE)
          .limit(PAGE_SIZE)
          .populate('plan', 'name slug price limits')
          .lean()
      ]);

      let stats = {};
      if (withStats) {
        const rows = await Promise.all(gyms.map((gym) => collectGymStats(gym)));
        gyms.forEach((gym, index) => {
          stats[String(gym._id)] = rows[index];
        });
      }

      return res.json({
        success: true,
        data: gyms.map((gym) => ({ ...publicGym(gym), stats: stats[String(gym._id)] || null })),
        pagination: { page, page_size: PAGE_SIZE, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) }
      });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/platform/gyms   { ...provisionGym input, demoRequestId? }
  //
  // Answers 201 with the gym, `ownerInviteSent` (did the owner get their
  // set-password email), `inviteSiteUrl` (the site that link opens on) and
  // `warnings` for anything that did not go to plan but did not stop the gym
  // being created. `demoRequestId` names the checkout or demo request it was
  // set up from; that request is marked converted and linked to the gym.
  create: async (req, res) => {
    try {
      const body = req.body || {};
      const { gym, seeded, warnings, ownerInvite, inviteSiteUrl } = await provisionGym(body, {
        createdBy: req.superAdmin._id,
        enforceDatabasePolicy: true,
        requireSite: true
      });
      const converted = await markRequestConverted(body.demoRequestId, gym, req.superAdmin);
      if (converted.warning) warnings.push(converted.warning);
      audit(req, 'gym_created', gym, {
        slug: gym.slug,
        domains: gym.domains.map((d) => d.host),
        ownerInviteSent: !!ownerInvite.sent,
        demoRequestId: converted.request ? converted.request.id : null
      });
      return res.status(201).json({
        success: true,
        message: `${gym.name} is ready.`,
        data: publicGym(gym),
        owner: seeded.owner,
        ownerInviteSent: !!ownerInvite.sent,
        inviteSiteUrl,
        demoRequest: converted.request,
        warnings
      });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/platform/gyms/:id
  get: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

      const [plan, stats] = await Promise.all([
        gym.plan ? PlatformPlan.findById(gym.plan).lean() : null,
        collectGymStats(gym.toObject())
      ]);

      return res.json({ success: true, data: { ...publicGym(gym), plan, stats } });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/platform/gyms/:id/stats
  stats: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });
      return res.json({ success: true, data: await collectGymStats(gym.toObject()) });
    } catch (error) {
      return fail(res, error);
    }
  },

  // PUT /api/platform/gyms/:id  -- name, owner contact, locale, notes
  update: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

      const body = req.body || {};
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return res.status(400).json({ success: false, message: 'Gym name cannot be empty' });
        gym.name = name;
      }
      if (body.owner && typeof body.owner === 'object') {
        for (const key of ['firstName', 'lastName', 'email', 'phone']) {
          if (body.owner[key] !== undefined) gym.owner[key] = String(body.owner[key] || '').trim();
        }
      }
      if (body.locale && typeof body.locale === 'object') {
        if (body.locale.timezone !== undefined) {
          const tz = String(body.locale.timezone || '').trim() || 'UTC';
          try {
            new Intl.DateTimeFormat('en-GB', { timeZone: tz });
          } catch {
            return res.status(400).json({ success: false, message: `"${tz}" is not a valid IANA timezone` });
          }
          gym.locale.timezone = tz;
        }
        if (body.locale.currency !== undefined) gym.locale.currency = String(body.locale.currency || 'USD').toUpperCase().trim();
        if (body.locale.country !== undefined) gym.locale.country = String(body.locale.country || '').trim();
      }
      if (body.notes !== undefined) gym.notes = String(body.notes || '');

      await gym.save();
      invalidateTenantCache();
      audit(req, 'gym_updated', gym, { fields: Object.keys(body) });

      return res.json({ success: true, data: publicGym(gym) });
    } catch (error) {
      return fail(res, error);
    }
  },

  // PUT /api/platform/gyms/:id/domains   { domains: [{ host, isPrimary }] }
  updateDomains: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

      const before = new Set((gym.domains || []).map((d) => d.host));
      await replaceDomains(gym, (req.body || {}).domains);
      audit(req, 'gym_domains_updated', gym, { domains: gym.domains.map((d) => d.host) });

      // Put new hosts on the website's Vercel project and take removed ones
      // off, when Vercel is connected. Best effort: the domain is saved on the
      // gym either way, and the panel shows what to do next.
      const vercel = require('../vercelDomains');
      const after = new Set(gym.domains.map((d) => d.host));
      const hosting = {
        connected: vercel.configured(),
        added: await Promise.all([...after].filter((h) => !before.has(h) && !/^localhost(:\d+)?$/.test(h)).map((h) => vercel.addDomain(h))),
        removed: await Promise.all([...before].filter((h) => !after.has(h) && !/^localhost(:\d+)?$/.test(h)).map((h) => vercel.removeDomain(h)))
      };

      return res.json({ success: true, data: publicGym(gym), hosting });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/platform/gyms/:id/domains/status  -> is each domain live on Vercel?
  domainsStatus: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });
      const vercel = require('../vercelDomains');
      const hosts = (gym.domains || []).map((d) => d.host).filter((h) => !/^localhost(:\d+)?$/.test(h));
      const data = await Promise.all(hosts.map((h) => vercel.domainStatus(h)));
      return res.json({ success: true, connected: vercel.configured(), data });
    } catch (error) {
      return fail(res, error);
    }
  },

  // PATCH /api/platform/gyms/:id/status   { status: 'active' | 'suspended' }
  setStatus: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

      const { status } = req.body || {};
      if (!Gym.GYM_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: `Status must be one of: ${Gym.GYM_STATUSES.join(', ')}` });
      }

      gym.status = status;
      await gym.save();
      invalidateTenantCache();
      audit(req, status === 'suspended' ? 'gym_suspended' : 'gym_activated', gym);

      return res.json({ success: true, data: publicGym(gym) });
    } catch (error) {
      return fail(res, error);
    }
  },

  // PUT /api/platform/gyms/:id/subscription
  //   { planId, status, billingCycle, amount, currency, startedAt, currentPeriodEnd, notes }
  updateSubscription: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

      const body = req.body || {};
      const planBefore = gym.plan ? String(gym.plan) : '';
      let plan = null;
      if (body.planId !== undefined) {
        if (body.planId) {
          if (!mongoose.Types.ObjectId.isValid(body.planId)) {
            return res.status(400).json({ success: false, message: 'Invalid plan id' });
          }
          plan = await PlatformPlan.findById(body.planId).lean();
          if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
        }
        gym.plan = plan ? plan._id : null;
      } else if (gym.plan) {
        plan = await PlatformPlan.findById(gym.plan).lean();
      }

      if (body.status !== undefined && !Gym.SUBSCRIPTION_STATUSES.includes(body.status)) {
        return res.status(400).json({ success: false, message: `Subscription status must be one of: ${Gym.SUBSCRIPTION_STATUSES.join(', ')}` });
      }
      if (body.billingCycle !== undefined && !Gym.BILLING_CYCLES.includes(body.billingCycle)) {
        return res.status(400).json({ success: false, message: `Billing cycle must be one of: ${Gym.BILLING_CYCLES.join(', ')}` });
      }
      for (const key of ['startedAt', 'currentPeriodEnd']) {
        if (body[key] && Number.isNaN(new Date(body[key]).getTime())) {
          return res.status(400).json({ success: false, message: `${key} is not a valid date` });
        }
      }

      // Add-ons the gym keeps unless this request names a different set.
      let addons;
      try {
        addons = await resolveAddons(
          body.addonSlugs !== undefined ? body.addonSlugs : (gym.subscription && gym.subscription.addons || []).map((a) => a.slug),
          plan
        );
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, message: error.message });
      }

      const current = gym.toObject().subscription || {};
      const next = subscriptionFor(plan, {
        status: body.status || current.status,
        billingCycle: body.billingCycle || current.billingCycle,
        amount:
          body.amount !== undefined
            ? body.amount
            : plan && body.planId === undefined && body.billingCycle === undefined
            ? current.planAmount ?? current.amount
            : undefined,
        currency: body.currency || current.currency,
        startedAt: body.startedAt || current.startedAt,
        // An explicit null clears the date (a plan then gets a fresh period
        // from today); leaving it out keeps what was there.
        currentPeriodEnd: body.currentPeriodEnd === null ? null : body.currentPeriodEnd || current.currentPeriodEnd,
        notes: body.notes !== undefined ? body.notes : current.notes
      }, addons);
      next.cancelledAt = next.status === 'cancelled' ? current.cancelledAt || new Date() : null;

      // An add-on already on the bill keeps the price it was sold at while
      // the cycle stays the same -- snapshots, not references (see gymModel)
      // -- so saving a note never re-prices a gym, here or on Stripe. One
      // that was free (included) and no longer is gets its list price.
      if (next.billingCycle === (current.billingCycle || 'monthly')) {
        const agreed = new Map((current.addons || []).map((a) => [a.slug, Number(a.amount) || 0]));
        for (const addon of next.addons) {
          if (addon.amount > 0 && agreed.get(addon.slug) > 0) addon.amount = agreed.get(addon.slug);
        }
        next.amount = next.addons.reduce((total, addon) => total + (Number(addon.amount) || 0), Number(next.planAmount) || 0);
      }

      // subscriptionFor builds the subscription from scratch; what Stripe
      // knows about the gym is not its business and is carried over. The
      // notices start again when the period end moves, so a renewed gym gets
      // its next round of reminders.
      for (const key of STRIPE_FIELDS) next[key] = current[key] || '';
      // When the last Stripe event landed is what keeps a late, older event
      // from undoing a newer one (see platformWebhook) -- Stripe's to move.
      next.stripeEventAt = current.stripeEventAt || null;
      const periodBefore = current.currentPeriodEnd ? new Date(current.currentPeriodEnd).getTime() : 0;
      const periodAfter = next.currentPeriodEnd ? new Date(next.currentPeriodEnd).getTime() : 0;
      next.notices = periodBefore === periodAfter && current.notices ? { ...current.notices } : {};

      // A gym that pays by card is charged whatever Stripe says, so a change
      // to its price goes to Stripe first -- prorated -- and is written here
      // only once Stripe has taken it. Otherwise Stripe keeps charging the
      // old price and its next webhook writes the old amount back.
      let stripeSynced = false;
      if (current.stripeSubscriptionId && changesPrice(current, next, planBefore, gym.plan ? String(gym.plan) : '')) {
        try {
          const synced = await syncStripeSubscription({ gym: gym.toObject(), plan, next });
          stripeSynced = synced.synced;
          if (synced.summary) next.stripePriceSummary = synced.summary;
        } catch (error) {
          if (error instanceof SubscriptionSyncError) {
            return res.status(error.status).json({ success: false, code: error.code, message: error.message });
          }
          throw error;
        }
      }

      gym.subscription = next;
      await gym.save();
      invalidateTenantCache();
      invalidatePlanCache();
      audit(req, 'gym_subscription_updated', gym, {
        plan: plan ? plan.slug : null,
        status: next.status,
        currentPeriodEnd: next.currentPeriodEnd,
        stripeSynced
      });

      return res.json({ success: true, data: publicGym(gym), stripeSynced });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/platform/gyms/:id/admins  -- administrator accounts inside the gym
  listAdmins: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

      const admins = await runWithTenant(gym.toObject(), () =>
        User.find({ role: ADMIN_SLUG })
          .select('firstName lastName email isActive lastLogin createdAt')
          .sort({ createdAt: 1 })
          .lean()
      );

      return res.json({
        success: true,
        data: admins.map((a) => ({
          id: String(a._id),
          name: [a.firstName, a.lastName].filter(Boolean).join(' '),
          email: a.email,
          is_active: a.isActive !== false,
          last_login: a.lastLogin || null,
          created_at: a.createdAt
        }))
      });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/platform/gyms/:id/reset-owner-password   { email?, password? }
  //
  // For support: a locked-out owner, or one who never got their invite.
  // With a password, sets it on the administrator inside the gym (creating
  // the account if the address is new). Without one, nothing about the
  // password changes: the owner is emailed a set-password link instead --
  // "resend the invite". Either way the link is sent; the answer says
  // whether it went, and a delivery problem is a warning, not a failure.
  resetOwnerPassword: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

      const body = req.body || {};
      const email = String(body.email || gym.owner.email || '').toLowerCase().trim();
      const password = body.password === undefined || body.password === null || body.password === '' ? null : body.password;
      if (!email) return res.status(400).json({ success: false, message: 'An email address is required' });
      if (password !== null && (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH)) {
        return res.status(400).json({ success: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }

      const target = gym.toObject();
      const result = await runWithTenant(target, async () => {
        let user = await User.findOne({ email });
        let created = false;
        if (user) {
          if (password !== null) {
            user.password = await bcrypt.hash(password, await bcrypt.genSalt(10));
            user.provider = 'local';
          }
          user.role = ADMIN_SLUG;
          user.isActive = true;
          await user.save();
        } else {
          // A new account with no password given gets one nobody knows; the
          // set-password link is how the owner gets in.
          const secret = password !== null ? password : crypto.randomBytes(24).toString('base64url');
          user = await User.create({
            firstName: gym.owner.firstName || 'Gym',
            lastName: gym.owner.lastName || 'Owner',
            email,
            password: await bcrypt.hash(secret, await bcrypt.genSalt(10)),
            role: ADMIN_SLUG,
            isActive: true,
            employment: { isStaff: true, jobTitle: 'Owner', joinedAt: new Date() }
          });
          created = true;
        }

        let invite;
        try {
          invite = await sendOwnerInvite({ gym: target, email: user.email, siteUrl: inviteSiteUrlFor(target), resend: true });
        } catch (error) {
          invite = { sent: false, error: error.message };
        }
        return { created, email: user.email, passwordSet: password !== null, inviteSent: !!invite.sent, inviteError: invite.error || null };
      });

      audit(req, password !== null ? 'gym_owner_password_reset' : 'gym_owner_invite_sent', gym, {
        email,
        created: result.created,
        inviteSent: result.inviteSent
      });
      return res.json({
        success: true,
        data: { created: result.created, email: result.email, passwordSet: result.passwordSet, inviteSent: result.inviteSent },
        warnings: result.inviteSent ? [] : ['Owner email could not be sent']
      });
    } catch (error) {
      return fail(res, error);
    }
  },

  // DELETE /api/platform/gyms/:id   { confirmSlug, dropDatabase }
  remove: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

      const { confirmSlug, dropDatabase } = req.body || {};
      const result = await deleteGym(gym, { confirmSlug, dropDatabase: dropDatabase === true || dropDatabase === 'true' });
      audit(req, 'gym_deleted', gym, { slug: gym.slug, databaseDropped: result.databaseDropped });

      return res.json({ success: true, data: result });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/platform/audit?action=&gymId=&limit=
  //
  // Newest first. `action` narrows to one kind of entry (the Stripe page
  // asks for platform_stripe_event), `gymId` to one gym, `limit` caps the
  // rows (default and maximum 200).
  auditLog: async (req, res) => {
    try {
      const filter = {};
      const action = String(req.query.action || '').trim();
      if (action) filter.action = action;
      if (req.query.gymId && mongoose.Types.ObjectId.isValid(String(req.query.gymId))) filter.gymId = req.query.gymId;
      const limit = Math.min(AUDIT_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || AUDIT_LIMIT));

      const rows = await PlatformAuditLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
      return res.json({ success: true, data: rows.map((r) => ({ ...r, gymId: r.gymId ? String(r.gymId) : null })) });
    } catch (error) {
      return fail(res, error);
    }
  }
};
