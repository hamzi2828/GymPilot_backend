// src/platform/controllers/demoRequestsController.js
//
// Demo requests from the marketing site. `submit` is public (rate limited,
// honeypot-checked); `list` and `update` are the panel's view of them.

const DemoRequest = require('../models/demoRequestModel');
const SuperAdmin = require('../models/superAdminModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const { sendEmail } = require('../../services/emailService');
const { shell, paragraph, detailTable, escapeHtml } = require('../../templates/gymEmails');

const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymPilot';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A second request from the same address inside this window is the same
// person pressing the button twice, not a new lead.
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const THANKS = 'Thanks — we will be in touch within one working day.';

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Checks and trims a submission. Returns { spam: true } for a filled
 * honeypot, otherwise { errors: [...], data: {...} }.
 */
function validateDemoRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  // Bots fill every field they find; people never see this one.
  if (text(b.website, 10)) return { spam: true, errors: [], data: null };

  const data = {
    name: text(b.name, 120),
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

function panelUrl() {
  const origin = (process.env.PLATFORM_ADMIN_ORIGIN || process.env.FRONTEND_ORIGIN || 'http://localhost:3001').replace(/\/+$/, '');
  return `${origin}/super-admin/demo-requests`;
}

// Tells every active platform admin. Email failures are logged, never
// surfaced: the request is already saved.
async function notifyAdmins(request) {
  const admins = await SuperAdmin.find({ isActive: true }).select('email').lean();
  if (!admins.length) return;
  const body = [
    paragraph(`A gym asked for a demo on the ${escapeHtml(PLATFORM_NAME)} website.`),
    detailTable([
      ['Name', request.name],
      ['Email', request.email],
      ['Phone', request.phone],
      ['Gym', request.gymName],
      ['Size', request.gymSize],
      ['Country / city', request.country]
    ]),
    request.message ? paragraph(`“${escapeHtml(request.message)}”`) : '',
    paragraph(`Record where it goes in the panel: <a href="${panelUrl()}">${panelUrl()}</a>`)
  ].join('');
  const subject = `New demo request: ${request.gymName || request.name}`;
  await Promise.all(admins.map((a) => sendEmail(a.email, subject, shell(PLATFORM_NAME, 'New demo request', body))));
}

function publicRow(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    phone: doc.phone || '',
    gymName: doc.gymName || '',
    gymSize: doc.gymSize || '',
    country: doc.country || '',
    message: doc.message || '',
    source: doc.source || '',
    status: doc.status,
    notes: doc.notes || '',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

module.exports = {
  validateDemoRequest,

  // POST /api/platform/public/demo-requests
  submit: async (req, res) => {
    try {
      const result = validateDemoRequest(req.body);
      // A bot is told thanks and nothing is stored.
      if (result.spam) return res.status(201).json({ success: true, message: THANKS });
      if (result.errors.length) return res.status(400).json({ success: false, message: result.errors[0], errors: result.errors });

      const recent = await DemoRequest.findOne({ email: result.data.email, createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) } })
        .select('_id')
        .lean();
      if (recent) return res.status(201).json({ success: true, message: THANKS, id: String(recent._id) });

      const doc = await DemoRequest.create({ ...result.data, ip: clientIp(req), userAgent: text(req.headers['user-agent'], 500) });
      notifyAdmins(doc).catch((err) => console.error('[platform] demo request email failed:', err.message));
      return res.status(201).json({ success: true, message: THANKS, id: String(doc._id) });
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
  }
};
