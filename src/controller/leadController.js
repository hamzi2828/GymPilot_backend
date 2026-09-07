// src/controller/leadController.js
//
// The lead pipeline: enquiries from the website, walk-ins and calls, worked
// until they join. "Make member" creates the account the way Users → New
// does (server-generated password, emailed) and links it back to the lead.

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Lead = require('../models/leadModel');
const User = require('../models/user');
const { sendEmail } = require('../services/emailService');
const { shell, paragraph, button, escapeHtml } = require('../templates/gymEmails');
const notify = require('../services/gymNotifications');
const { checkLimit } = require('../platform/planLimits');

const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const actorId = (req) => req.user && (req.user.id || req.user._id);
const text = (v, max = 500) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max));

function fail(res, code, message) {
  return res.status(code).json({ success: false, message });
}

function view(lead, names = new Map()) {
  return {
    id: String(lead._id),
    first_name: lead.firstName,
    last_name: lead.lastName || '',
    name: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
    email: lead.email || '',
    phone: lead.phone || '',
    source: lead.source,
    status: lead.status,
    interest: lead.interest || '',
    assigned_to: lead.assignedTo ? String(lead.assignedTo) : null,
    assigned_name: lead.assignedTo ? names.get(String(lead.assignedTo)) || '' : '',
    next_follow_up_at: lead.nextFollowUpAt || null,
    last_contacted_at: lead.lastContactedAt || null,
    notes: (lead.notes || []).map((n) => ({ id: String(n._id), text: n.text, by_name: n.byName || '', at: n.at })),
    tags: lead.tags || [],
    lost_reason: lead.lostReason || '',
    converted_user_id: lead.convertedUserId ? String(lead.convertedUserId) : null,
    converted_at: lead.convertedAt || null,
    created_at: lead.createdAt,
    updated_at: lead.updatedAt
  };
}

async function staffNames(leads) {
  const ids = [...new Set(leads.map((l) => l.assignedTo).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const users = await User.find({ _id: { $in: ids } }).select('firstName lastName email').lean();
  return new Map(users.map((u) => [String(u._id), [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email]));
}

async function actorName(req) {
  const me = await User.findById(actorId(req)).select('firstName lastName email').lean();
  return me ? [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email : '';
}

function readDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function generatePassword(length = 14) {
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*';
  const all = upper + lower + digits + symbols;
  const pick = (set) => set[crypto.randomInt(0, set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Called by the public contact form: an enquiry becomes a lead unless one
 * is already open for the same person, in which case it becomes a note on
 * it. Never throws -- the enquiry itself has already been saved.
 */
async function leadFromContact(contact) {
  try {
    const email = String(contact.emailAddress || '').toLowerCase().trim();
    const phone = String(contact.phoneNumber || '').trim();
    const or = [];
    if (email) or.push({ email });
    if (phone) or.push({ phone });
    const existing = or.length ? await Lead.findOne({ $or: or, status: { $nin: ['won', 'lost'] } }) : null;
    const summary = [contact.subject, contact.message].filter(Boolean).join(' — ').slice(0, 500);
    if (existing) {
      existing.notes.push({ text: `Website enquiry: ${summary}`, byName: 'Website' });
      existing.lastContactedAt = new Date();
      await existing.save();
      return existing;
    }
    // Already a member? Then it is a support message, not a lead.
    if (email && (await User.exists({ email }))) return null;
    const [firstName, ...rest] = String(contact.fullName || 'Enquiry').trim().split(/\s+/);
    return await Lead.create({
      firstName: firstName || 'Enquiry',
      lastName: rest.join(' '),
      email,
      phone,
      source: 'website',
      interest: String(contact.subject || '').slice(0, 200),
      notes: summary ? [{ text: `Website enquiry: ${summary}`, byName: 'Website' }] : [],
      contactId: contact._id
    });
  } catch (error) {
    console.error('[leads] from contact failed:', error.message);
    return null;
  }
}

module.exports = {
  leadFromContact,

  // GET /admin/leads?status=&search=&limit=
  list: async (req, res) => {
    try {
      const filter = { isActive: { $ne: false } };
      if (req.query.status && Lead.STATUSES.includes(req.query.status)) filter.status = req.query.status;
      if (req.query.search && String(req.query.search).trim()) {
        const rx = new RegExp(String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }, { interest: rx }];
      }
      const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
      const rows = await Lead.find(filter).sort({ nextFollowUpAt: 1, createdAt: -1 }).limit(limit).lean();
      const names = await staffNames(rows);
      const counts = await Lead.aggregate([{ $match: { isActive: { $ne: false } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
      return res.json({ success: true, data: rows.map((l) => view(l, names)), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
    } catch (error) {
      console.error('[leads] list failed:', error);
      return fail(res, 500, 'Could not load leads');
    }
  },

  // POST /admin/leads
  create: async (req, res) => {
    try {
      const body = req.body || {};
      const firstName = text(body.firstName, 80);
      if (!firstName) return fail(res, 400, 'A first name is required');
      const lead = await Lead.create({
        firstName,
        lastName: text(body.lastName, 80) || '',
        email: (text(body.email, 200) || '').toLowerCase(),
        phone: text(body.phone, 40) || '',
        source: Lead.SOURCES.includes(body.source) ? body.source : 'walk_in',
        status: Lead.STATUSES.includes(body.status) ? body.status : 'new',
        interest: text(body.interest, 200) || '',
        assignedTo: isId(body.assignedTo) ? body.assignedTo : null,
        nextFollowUpAt: readDate(body.nextFollowUpAt) || null,
        tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20) : [],
        notes: text(body.note) ? [{ text: text(body.note), by: actorId(req), byName: await actorName(req) }] : [],
        createdBy: actorId(req)
      });
      return res.status(201).json({ success: true, data: view(lead) });
    } catch (error) {
      console.error('[leads] create failed:', error);
      return fail(res, 500, 'Could not add the lead');
    }
  },

  // PUT /admin/leads/:id
  update: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Lead not found');
      const lead = await Lead.findById(req.params.id);
      if (!lead) return fail(res, 404, 'Lead not found');
      const body = req.body || {};
      const firstName = text(body.firstName, 80);
      if (firstName) lead.firstName = firstName;
      if (body.lastName !== undefined) lead.lastName = text(body.lastName, 80) || '';
      if (body.email !== undefined) lead.email = (text(body.email, 200) || '').toLowerCase();
      if (body.phone !== undefined) lead.phone = text(body.phone, 40) || '';
      if (body.source !== undefined && Lead.SOURCES.includes(body.source)) lead.source = body.source;
      if (body.interest !== undefined) lead.interest = text(body.interest, 200) || '';
      if (body.assignedTo !== undefined) lead.assignedTo = isId(body.assignedTo) ? body.assignedTo : null;
      const follow = readDate(body.nextFollowUpAt);
      if (follow !== undefined) lead.nextFollowUpAt = follow;
      if (Array.isArray(body.tags)) lead.tags = body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20);
      if (body.lostReason !== undefined) lead.lostReason = text(body.lostReason, 300) || '';
      await lead.save();
      return res.json({ success: true, data: view(lead) });
    } catch (error) {
      console.error('[leads] update failed:', error);
      return fail(res, 500, 'Could not save the lead');
    }
  },

  // PATCH /admin/leads/:id/status   { status, lostReason }
  setStatus: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Lead not found');
      const { status, lostReason } = req.body || {};
      if (!Lead.STATUSES.includes(status)) return fail(res, 400, `status must be one of ${Lead.STATUSES.join(', ')}`);
      const lead = await Lead.findById(req.params.id);
      if (!lead) return fail(res, 404, 'Lead not found');
      lead.status = status;
      if (status === 'contacted' || status === 'trial') lead.lastContactedAt = new Date();
      if (status === 'lost') lead.lostReason = text(lostReason, 300) || lead.lostReason || '';
      await lead.save();
      return res.json({ success: true, data: view(lead) });
    } catch (error) {
      console.error('[leads] status failed:', error);
      return fail(res, 500, 'Could not update the lead');
    }
  },

  // POST /admin/leads/:id/notes   { text }
  addNote: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Lead not found');
      const note = text((req.body || {}).text, 2000);
      if (!note) return fail(res, 400, 'Write a note');
      const lead = await Lead.findById(req.params.id);
      if (!lead) return fail(res, 404, 'Lead not found');
      lead.notes.push({ text: note, by: actorId(req), byName: await actorName(req) });
      lead.lastContactedAt = new Date();
      await lead.save();
      return res.json({ success: true, data: view(lead) });
    } catch (error) {
      console.error('[leads] note failed:', error);
      return fail(res, 500, 'Could not add the note');
    }
  },

  // POST /admin/leads/:id/convert  -> member account + password email
  convert: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Lead not found');
      const lead = await Lead.findById(req.params.id);
      if (!lead) return fail(res, 404, 'Lead not found');
      if (lead.convertedUserId) return fail(res, 409, 'This lead already has a member account');
      if (!lead.email) return fail(res, 400, 'Add an email address to the lead first');

      let user = await User.findOne({ email: lead.email });
      let created = false;
      let emailed = false;
      if (!user) {
        const limit = await checkLimit('members');
        if (!limit.ok) return res.status(403).json({ success: false, message: limit.message, code: limit.code });
        const password = generatePassword();
        user = await User.create({
          firstName: lead.firstName,
          lastName: lead.lastName || '',
          email: lead.email,
          password: await bcrypt.hash(password, await bcrypt.genSalt(10)),
          role: 'user',
          phone: lead.phone || null,
          source: lead.source,
          tags: lead.tags || []
        });
        created = true;
        const b = await notify.brand();
        const loginUrl = `${b.accountUrl.replace(/\/user-detail$/, '')}/authentication`;
        const body = [
          paragraph(`Hi ${escapeHtml(user.firstName)}, welcome to ${escapeHtml(b.siteName)}! Your account is ready.`),
          paragraph(`<strong>Email:</strong> ${escapeHtml(user.email)}<br><strong>Temporary password:</strong> ${escapeHtml(password)}`),
          paragraph('Sign in and change your password from your profile.'),
          button(loginUrl, 'Sign in')
        ].join('');
        const result = await sendEmail(user.email, `Your ${b.siteName} account`, shell(b.siteName, 'Welcome!', body));
        emailed = !!result.success;
      }

      lead.status = 'won';
      lead.convertedUserId = user._id;
      lead.convertedAt = new Date();
      lead.notes.push({ text: created ? `Member account created (${emailed ? 'password emailed' : 'password email failed'})` : 'Linked to existing member account', by: actorId(req), byName: await actorName(req) });
      await lead.save();

      return res.json({
        success: true,
        message: created ? (emailed ? `${user.email} is now a member and has been emailed a password.` : `${user.email} is now a member, but the password email failed — reset it from Users.`) : `${user.email} already had an account; the lead is linked to it.`,
        data: view(lead)
      });
    } catch (error) {
      console.error('[leads] convert failed:', error);
      return fail(res, 500, 'Could not create the member account');
    }
  },

  // DELETE /admin/leads/:id
  remove: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Lead not found');
      await Lead.deleteOne({ _id: req.params.id });
      return res.json({ success: true, message: 'Lead deleted.' });
    } catch (error) {
      console.error('[leads] delete failed:', error);
      return fail(res, 500, 'Could not delete the lead');
    }
  }
};
