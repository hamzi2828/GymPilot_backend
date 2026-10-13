// src/platform/controllers/demoRequestsController.js
//
// Demo requests from the marketing site. `submit` is public (rate limited,
// honeypot-checked); `list` and `update` are the panel's view of them --
// including the signups that paid online (controllers/signupController.js),
// which are kept as the same record with kind 'signup'.

const DemoRequest = require('../models/demoRequestModel');
const PlatformPlan = require('../models/platformPlanModel');
const PlatformAddon = require('../models/platformAddonModel');
const SuperAdmin = require('../models/superAdminModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const { sendEmail } = require('../../services/emailService');
const { afterResponse } = require('../../services/afterResponse');
const { shell, paragraph, detailTable, escapeHtml } = require('../../templates/gymEmails');
const { localFallback } = require('../tenantContext');

const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymsPilotPro';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A second request of the same KIND from the same address inside this window
// is the same person pressing the button twice, not a new lead. A checkout
// after a demo request is a different thing and is always kept.
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const THANKS = 'Thanks — we will be in touch within one working day.';

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * What a checkout chose, priced here rather than trusted from the form.
 * Returns null when no plan was picked (an ordinary demo request); otherwise
 * `{ plan, warnings }` -- the warnings say what was left off and why.
 */
async function priceSelection(data) {
  if (!data.planSlug) return null;
  const plan = await PlatformPlan.findOne({ slug: data.planSlug, isActive: true }).lean();
  if (!plan) return null;

  const yearly = data.billingCycle === 'yearly';
  const included = (plan.includedAddons || []).map((s) => String(s).toLowerCase());
  const wanted = [...new Set([...included, ...data.addonSlugs])];

  const addons = wanted.length
    ? await PlatformAddon.find({ slug: { $in: wanted }, isActive: true }).lean()
    : [];
  const sold = addons.filter(
    (addon) => included.includes(addon.slug) || !addon.planSlugs || !addon.planSlugs.length || addon.planSlugs.includes(plan.slug)
  );

  // A paid add-on in another currency than the plan cannot go on the same
  // bill; it is left off and the panel is told.
  const planCurrency = String(plan.price.currency || '').toUpperCase();
  const warnings = [];
  const usable = sold.filter((addon) => {
    const currency = String((addon.price && addon.price.currency) || '').toUpperCase();
    if (included.includes(addon.slug) || !currency || !planCurrency || currency === planCurrency) return true;
    warnings.push(`Add-on ${addon.name} is priced in ${currency} but the plan is in ${planCurrency}; it was left off`);
    return false;
  });

  const amount = usable.reduce(
    (total, addon) => total + (included.includes(addon.slug) ? 0 : (yearly ? addon.price.yearly : addon.price.monthly) || 0),
    (yearly ? plan.price.yearly : plan.price.monthly) || 0
  );

  return {
    plan: {
      slug: plan.slug,
      name: plan.name,
      billingCycle: data.billingCycle,
      addonSlugs: usable.map((a) => a.slug),
      addonNames: usable.map((a) => a.name),
      amount,
      currency: plan.price.currency,
      trialDays: plan.trialDays || 0
    },
    warnings
  };
}

/**
 * Checks and trims a submission. Returns { spam: true } for a filled
 * honeypot, otherwise { errors: [...], data: {...} }.
 */
function validateDemoRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  // Bots fill every field they find; people never see this one.
  if (text(b.website, 10)) return { spam: true, errors: [], data: null };

  // Checkout sends the name in two halves (that is how the owner's account
  // is created); the demo form sends one. Both are kept, and one is derived
  // from the other when only one arrived.
  const firstName = text(b.firstName, 60);
  const lastName = text(b.lastName, 60);
  const data = {
    kind: b.kind === 'trial' ? 'trial' : 'demo',
    // Only ever a suggestion; the slug a gym actually gets is decided when it
    // is set up.
    preferredSlug: text(b.preferredSlug, 60)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, ''),
    planSlug: text(b.planSlug, 60).toLowerCase(),
    billingCycle: b.billingCycle === 'yearly' ? 'yearly' : 'monthly',
    addonSlugs: (Array.isArray(b.addonSlugs) ? b.addonSlugs : [])
      .map((slug) => text(slug, 60).toLowerCase())
      .filter(Boolean)
      .slice(0, 10),
    name: text(b.name, 120) || `${firstName} ${lastName}`.trim().slice(0, 120),
    firstName,
    lastName,
    email: text(b.email, 200).toLowerCase(),
    phone: text(b.phone, 40),
    gymName: text(b.gymName, 160),
    gymSize: text(b.gymSize, 60),
    country: text(b.country, 120),
    message: text(b.message, 4000),
    source: text(b.source, 500)
  };
  const errors = [];
  if (!data.name) errors.push('Your name is required');
  if (!data.email || !EMAIL_RE.test(data.email)) errors.push('A valid email address is required');
  if (!data.gymName) errors.push('The gym name is required');
  return { spam: false, errors, data };
}

/**
 * Where the panel's Demo requests page is, or '' when this server has not
 * been told where its panel lives (PLATFORM_ADMIN_ORIGIN). Localhost stands
 * in on a developer's machine only -- never in an email sent from production.
 */
function panelUrl() {
  // PLATFORM_ADMIN_ORIGIN may list several origins for CORS; links use the first.
  const origin = (process.env.PLATFORM_ADMIN_ORIGIN || process.env.FRONTEND_ORIGIN || localFallback('http://localhost:3001') || '').split(',')[0].trim().replace(/\/+$/, '');
  if (!origin) {
    if (!panelUrl.warned) console.error('[platform] PLATFORM_ADMIN_ORIGIN is not set, so emails to the platform admins carry no link to the panel');
    panelUrl.warned = true;
    return '';
  }
  return `${origin}/super-admin/demo-requests`;
}

/** The panel link as a line of an admin email (after `lead`, if any), or nothing when there is no panel address to link to. */
function panelLink(lead = '') {
  const url = panelUrl();
  return url ? paragraph(`${lead}<a href="${url}">${url}</a>`) : '';
}

/**
 * Emails every active platform admin. Failures are logged by sendEmail and
 * never surfaced: whatever the email is about has already happened.
 */
async function emailAdmins(subject, heading, body) {
  const admins = await SuperAdmin.find({ isActive: true }).select('email').lean();
  if (!admins.length) return;
  await Promise.all(admins.map((a) => sendEmail(a.email, subject, shell(PLATFORM_NAME, heading, body))));
}

// Tells every active platform admin. Email failures are logged, never
// surfaced: the request is already saved.
async function notifyAdmins(request) {
  const body = [
    paragraph(
      request.kind === 'trial'
        ? `A gym filled in checkout on the ${escapeHtml(PLATFORM_NAME)} website and wants to start a trial.`
        : `A gym asked for a demo on the ${escapeHtml(PLATFORM_NAME)} website.`
    ),
    detailTable([
      ['Name', request.name],
      ['Email', request.email],
      ['Phone', request.phone],
      ['Gym', request.gymName],
      ['Size', request.gymSize],
      ['Country / city', request.country]
    ]),
    request.plan && request.plan.slug
      ? detailTable([
          ['Plan', `${request.plan.name} (${request.plan.billingCycle})`],
          ['Add-ons', (request.plan.addonNames || []).join(', ') || 'none'],
          ['Price', `${request.plan.currency} ${Number(request.plan.amount || 0).toLocaleString('en-US')} / ${request.plan.billingCycle === 'yearly' ? 'year' : 'month'}`],
          ['Trial', request.plan.trialDays ? `${request.plan.trialDays} days` : 'none'],
          ['Web address wanted', request.preferredSlug || '—']
        ])
      : '',
    (request.warnings || []).length ? paragraph(`Note: ${escapeHtml(request.warnings.join(' '))}`) : '',
    request.message ? paragraph(`“${escapeHtml(request.message)}”`) : '',
    panelLink('Record where it goes in the panel: ')
  ].join('');
  const subject = `${request.kind === 'trial' ? 'New trial signup' : 'New demo request'}: ${request.gymName || request.name}`;
  await emailAdmins(subject, 'New demo request', body);
}

/**
 * Tells the person who sent it that it arrived and what happens next -- a
 * checkout with no email back reads like one that went nowhere. Like the
 * admins' notice, a failure is logged and never surfaced: the request is
 * already saved.
 */
async function confirmToRequester(request) {
  const trial = request.kind === 'trial';
  const first = request.firstName || String(request.name || '').trim().split(/\s+/)[0] || 'there';
  const gym = escapeHtml(request.gymName || 'your gym');
  const plan = request.plan && request.plan.slug ? request.plan : null;
  const body = [
    paragraph(
      trial
        ? `Hi ${escapeHtml(first)}, thanks for choosing ${escapeHtml(PLATFORM_NAME)}. We have everything we need for ${gym} and are setting it up now.`
        : `Hi ${escapeHtml(first)}, thanks for asking to see ${escapeHtml(PLATFORM_NAME)} for ${gym}. Your request reached us.`
    ),
    plan
      ? detailTable([
          ['Plan', `${plan.name} (${plan.billingCycle})`],
          ['Add-ons', (plan.addonNames || []).join(', ') || 'none'],
          ['Free trial', plan.trialDays ? `${plan.trialDays} days` : ''],
          ['Then', `${plan.currency} ${Number(plan.amount || 0).toLocaleString('en-US')} / ${plan.billingCycle === 'yearly' ? 'year' : 'month'}`]
        ])
      : '',
    paragraph(
      trial
        ? 'Usually within one working day you will get a second email with your gym\'s web address and a link to set your admin password. Nothing to pay today.'
        : 'We will be in touch within one working day to arrange a walkthrough on your own numbers.'
    )
  ].join('');
  const subject = trial ? `We are setting up ${request.gymName || 'your gym'} on ${PLATFORM_NAME}` : `Your ${PLATFORM_NAME} demo request`;
  const result = await sendEmail(
    request.email,
    subject,
    shell(PLATFORM_NAME, trial ? 'Your gym is on its way' : 'Thanks for getting in touch', body, `You are receiving this because this address was entered on the ${escapeHtml(PLATFORM_NAME)} website. If that was not you, ignore this email.`)
  );
  if (!result || !result.success) {
    console.error(`[platform] demo request confirmation to ${request.email} failed:`, (result && result.error) || 'unknown error');
  }
}

function publicRow(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    firstName: doc.firstName || '',
    lastName: doc.lastName || '',
    email: doc.email,
    phone: doc.phone || '',
    gymName: doc.gymName || '',
    gymSize: doc.gymSize || '',
    country: doc.country || '',
    message: doc.message || '',
    kind: doc.kind || 'demo',
    preferredSlug: doc.preferredSlug || '',
    plan: doc.plan && doc.plan.slug ? doc.plan : null,
    warnings: doc.warnings || [],
    source: doc.source || '',
    status: doc.status,
    notes: doc.notes || '',
    gymId: doc.gymId ? String(doc.gymId) : null,
    convertedAt: doc.convertedAt || null,
    // How far a paid signup has got (see services/signupProvisioning.js);
    // null on a demo or trial request.
    signup:
      doc.kind === 'signup' && doc.signup
        ? {
            state: doc.signup.state,
            // Whether the buyer ever got as far as Stripe's payment page.
            paymentStarted: !!doc.signup.stripeSessionId,
            error: doc.signup.error || '',
            attempts: doc.signup.attempts || 0,
            siteUrl: doc.signup.siteUrl || '',
            trialEndsAt: doc.signup.trialEndsAt || null,
            inviteSent: !!doc.signup.inviteSent,
            stripeCustomerId: doc.signup.stripeCustomerId || '',
            stripeSubscriptionId: doc.signup.stripeSubscriptionId || ''
          }
        : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

module.exports = {
  validateDemoRequest,
  // for controllers/signupController.js and services/signupProvisioning.js
  priceSelection,
  emailAdmins,
  panelUrl,
  panelLink,

  // POST /api/platform/public/demo-requests
  submit: async (req, res) => {
    try {
      const result = validateDemoRequest(req.body);
      // A bot is told thanks and nothing is stored.
      if (result.spam) return res.status(201).json({ success: true, message: THANKS });
      if (result.errors.length) return res.status(400).json({ success: false, message: result.errors[0], errors: result.errors });

      const { planSlug, billingCycle, addonSlugs, ...fields } = result.data;
      const priced = await priceSelection(result.data);

      const recent = await DemoRequest.findOne({
        email: result.data.email,
        kind: result.data.kind,
        createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) }
      });
      // Whether a confirmation can go out at all. The emails below are sent
      // after the response, so nobody can wait on their result -- but a
      // platform whose mail server is not set up, or refuses its login, will
      // certainly send nothing, and the page must not promise an email that
      // cannot arrive. Asked of the server itself, and remembered for a
      // couple of minutes (services/platformEmail.js).
      const emailed = (await require('../services/platformEmail').verifyPlatformEmail()).ok;

      if (recent) {
        // Somebody going back to fix a typo or change their mind: everything
        // they sent the second time replaces the first on the same record --
        // a corrected name or phone number as much as a different plan --
        // rather than being dropped on the floor.
        recent.set(fields);
        if (priced) {
          recent.plan = priced.plan;
          recent.warnings = priced.warnings;
        }
        await recent.save();
        return res.status(201).json({ success: true, message: THANKS, id: String(recent._id), emailed });
      }

      const doc = await DemoRequest.create({
        ...fields,
        plan: priced ? priced.plan : undefined,
        warnings: priced ? priced.warnings : [],
        ip: clientIp(req),
        userAgent: text(req.headers['user-agent'], 500)
      });
      // Not waited for, but kept alive on Vercel until they have gone.
      afterResponse(() => notifyAdmins(doc), 'demo request email to admins');
      afterResponse(() => confirmToRequester(doc), 'demo request confirmation');
      return res.status(201).json({ success: true, message: THANKS, id: String(doc._id), emailed });
    } catch (error) {
      console.error('[platform] demo request failed:', error);
      return res.status(500).json({ success: false, message: 'Could not send your request right now. Please try again.' });
    }
  },

  // GET /api/platform/demo-requests?status=new
  list: async (req, res) => {
    try {
      const status = String(req.query.status || '');
      const filter = DemoRequest.STATUSES.includes(status) ? { status } : {};
      const [rows, byStatus] = await Promise.all([
        DemoRequest.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
        DemoRequest.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
      ]);
      const counts = {};
      for (const row of byStatus) counts[row._id] = row.count;
      return res.json({ success: true, data: rows.map(publicRow), counts });
    } catch (error) {
      console.error('[platform] demo requests list failed:', error);
      return res.status(500).json({ success: false, message: error.message || 'Request failed' });
    }
  },

  // GET /api/platform/demo-requests/:id
  //
  // One request, so the new-gym form can be filled in from it rather than
  // from somebody reading it off a screen and retyping.
  get: async (req, res) => {
    try {
      const doc = await DemoRequest.findById(req.params.id).lean();
      if (!doc) return res.status(404).json({ success: false, message: 'Demo request not found' });
      return res.json({ success: true, data: publicRow(doc) });
    } catch (error) {
      console.error('[platform] demo request get failed:', error);
      return res.status(500).json({ success: false, message: error.message || 'Request failed' });
    }
  },

  // PATCH /api/platform/demo-requests/:id   { status?, notes? }
  update: async (req, res) => {
    try {
      const doc = await DemoRequest.findById(req.params.id);
      if (!doc) return res.status(404).json({ success: false, message: 'Demo request not found' });
      const { status, notes } = req.body || {};
      if (status !== undefined) {
        if (!DemoRequest.STATUSES.includes(status)) return res.status(400).json({ success: false, message: 'Unknown status' });
        doc.status = status;
      }
      if (notes !== undefined) doc.notes = text(notes, 4000);
      doc.handledBy = req.superAdmin._id;
      await doc.save();
      PlatformAuditLog.record({
        actorId: req.superAdmin._id,
        actorEmail: req.superAdmin.email,
        action: 'demo_request_updated',
        meta: { id: String(doc._id), email: doc.email, status: doc.status },
        ip: clientIp(req)
      });
      return res.json({ success: true, data: publicRow(doc) });
    } catch (error) {
      console.error('[platform] demo request update failed:', error);
      return res.status(500).json({ success: false, message: error.message || 'Request failed' });
    }
  },

  // DELETE /api/platform/demo-requests/:id -- spam, duplicates, test entries.
  remove: async (req, res) => {
    try {
      const doc = await DemoRequest.findByIdAndDelete(req.params.id);
      if (!doc) return res.status(404).json({ success: false, message: 'Demo request not found' });
      PlatformAuditLog.record({
        actorId: req.superAdmin._id,
        actorEmail: req.superAdmin.email,
        action: 'demo_request_deleted',
        meta: { id: String(doc._id), email: doc.email, gymName: doc.gymName },
        ip: clientIp(req)
      });
      return res.json({ success: true });
    } catch (error) {
      console.error('[platform] demo request delete failed:', error);
      return res.status(500).json({ success: false, message: error.message || 'Request failed' });
    }
  }
};
