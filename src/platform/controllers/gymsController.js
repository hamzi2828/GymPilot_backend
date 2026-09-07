// src/platform/controllers/gymsController.js
//
// The platform panel's view of its customers: every gym, what it is on,
// whether it is being served, and the numbers from inside its database.

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Gym = require('../models/gymModel');
const PlatformPlan = require('../models/platformPlanModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const {
  ProvisioningError,
  provisionGym,
  replaceDomains,
  deleteGym,
  subscriptionFor
} = require('../provisioning');
const { collectGymStats } = require('../tenantStats');
const { runWithTenant } = require('../tenantContext');
const { invalidateTenantCache } = require('../middleware/resolveTenant');
const { invalidatePlanCache } = require('../planLimits');

const User = require('../../models/user');
const { ADMIN_SLUG } = require('../../services/roleService');

const MIN_PASSWORD_LENGTH = 8;
const PAGE_SIZE = 25;

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

function publicGym(doc) {
  const gym = doc && doc.toObject ? doc.toObject() : { ...doc };
  if (gym.database) gym.database = { name: gym.database.name };
  gym.id = String(gym._id);
  gym.access_block = Gym.accessBlock(gym);
  return gym;
}

async function loadGym(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Gym.findById(id);
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

      return res.json({
        success: true,
        data: {
          gyms: { total, active, suspended },
          subscriptions,
          expiring_within_30_days: expiringSoon,
          mrr: mrrRows.map((row) => ({ currency: row._id, amount: Math.round(row.mrr * 100) / 100, gyms: row.gyms }))
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

  // POST /api/platform/gyms
  create: async (req, res) => {
    try {
      const { gym, seeded } = await provisionGym(req.body || {}, { createdBy: req.superAdmin._id });
      audit(req, 'gym_created', gym, { slug: gym.slug, domains: gym.domains.map((d) => d.host) });
      return res.status(201).json({
        success: true,
        message: `${gym.name} is ready.`,
        data: publicGym(gym),
        owner: seeded.owner
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

      const current = gym.subscription || {};
      const next = subscriptionFor(plan, {
        status: body.status || current.status,
        billingCycle: body.billingCycle || current.billingCycle,
        amount: body.amount !== undefined ? body.amount : plan && body.planId === undefined && body.billingCycle === undefined ? current.amount : undefined,
        currency: body.currency || current.currency,
        startedAt: body.startedAt || current.startedAt,
        currentPeriodEnd: body.currentPeriodEnd || current.currentPeriodEnd,
        notes: body.notes !== undefined ? body.notes : current.notes
      });
      if (next.status === 'cancelled' && !current.cancelledAt) next.cancelledAt = new Date();
      if (next.status !== 'cancelled') next.cancelledAt = null;

      gym.subscription = next;
      await gym.save();
      invalidateTenantCache();
      invalidatePlanCache();
      audit(req, 'gym_subscription_updated', gym, {
        plan: plan ? plan.slug : null,
        status: next.status,
        currentPeriodEnd: next.currentPeriodEnd
      });

      return res.json({ success: true, data: publicGym(gym) });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/platform/gyms/:id/admins  -- administrator accounts inside the gym
  listAdmins: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

      const withUri = await Gym.findById(gym._id).select('+database.uri').lean();
      const admins = await runWithTenant(withUri, () =>
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

  // POST /api/platform/gyms/:id/reset-owner-password   { email?, password }
  //
  // For support: a locked-out owner. Sets the password on an existing
  // administrator inside the gym, or creates one if the address is new.
  resetOwnerPassword: async (req, res) => {
    try {
      const gym = await loadGym(req.params.id);
      if (!gym) return res.status(404).json({ success: false, message: 'Gym not found' });

      const body = req.body || {};
      const email = String(body.email || gym.owner.email || '').toLowerCase().trim();
      const password = body.password;
      if (!email) return res.status(400).json({ success: false, message: 'An email address is required' });
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ success: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }

      const withUri = await Gym.findById(gym._id).select('+database.uri').lean();
      const result = await runWithTenant(withUri, async () => {
        const hashed = await bcrypt.hash(password, await bcrypt.genSalt(10));
        let user = await User.findOne({ email });
        if (user) {
          user.password = hashed;
          user.role = ADMIN_SLUG;
          user.isActive = true;
          user.provider = 'local';
          await user.save();
          return { created: false, email: user.email };
        }
        user = await User.create({
          firstName: gym.owner.firstName || 'Gym',
          lastName: gym.owner.lastName || 'Owner',
          email,
          password: hashed,
          role: ADMIN_SLUG,
          isActive: true,
          employment: { isStaff: true, jobTitle: 'Owner', joinedAt: new Date() }
        });
        return { created: true, email: user.email };
      });

      audit(req, 'gym_owner_password_reset', gym, { email, created: result.created });
      return res.json({ success: true, data: result });
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

  // GET /api/platform/audit
  auditLog: async (req, res) => {
    try {
      const rows = await PlatformAuditLog.find({}).sort({ createdAt: -1 }).limit(200).lean();
      return res.json({ success: true, data: rows });
    } catch (error) {
      return fail(res, error);
    }
  }
};
