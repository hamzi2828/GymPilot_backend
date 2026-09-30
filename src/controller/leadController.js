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
const T = require('../attendance/services/timeUtils');

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
 * The lead already open for this person, matched on email or phone -- the
 * one a new enquiry from them is added to rather than duplicated. A lead
 * that was won or lost is closed: asking again starts a new one.
 */
function openLeadFor(email, phone) {
  const or = [];
  if (email) or.push({ email });
  if (phone) or.push({ phone });
  return or.length ? Lead.findOne({ $or: or, status: { $nin: ['won', 'lost'] } }) : null;
}

// A lead's follow-up date comes from a date input, which stores the chosen
// day as midnight UTC. So "due today or overdue" is "on or before today's
// date at the gym": anything before midnight UTC of the gym's tomorrow.
function followUpCutoff(todayKey) {
  return new Date(`${T.shiftDateKey(todayKey, 1)}T00:00:00.000Z`);
}

/**
 * The leads whose follow-up is due: still being worked (neither won nor
 * lost) with a follow-up date of today at the gym or earlier. The board's
 * "due for follow-up" filter (list's ?due=1) and the admin bell's "Lead
 * follow-ups due" both read this, so the count and the list agree.
 */
function followUpDueFilter(todayKey = T.dateKey()) {
  return {
    isActive: { $ne: false },
    status: { $nin: ['won', 'lost'] },
    nextFollowUpAt: { $ne: null, $lt: followUpCutoff(todayKey) }
  };
}

/** "Ann Marie Smith" -> first "Ann", last "Marie Smith". */
function splitName(fullName, fallback = 'Enquiry') {
  const [firstName, ...rest] = String(fullName || fallback).trim().split(/\s+/);
  return { firstName: (firstName || fallback).slice(0, 80), lastName: rest.join(' ').slice(0, 80) };
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
    const existing = await openLeadFor(email, phone);
    const summary = [contact.subject, contact.message].filter(Boolean).join(' — ').slice(0, 500);
    if (existing) {
      existing.notes.push({ text: `Website enquiry: ${summary}`, byName: 'Website' });
      existing.lastContactedAt = new Date();
      await existing.save();
      return existing;
    }
    // Already a member? Then it is a support message, not a lead.
    if (email && (await User.exists({ email }))) return null;
    const { firstName, lastName } = splitName(contact.fullName);
    return await Lead.create({
      firstName,
      lastName,
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

/* ------------------------- the website's enquiry form ------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The same words whatever happened, so the form never tells a stranger
// whether somebody is already known to the gym.
const ENQUIRY_THANKS = 'Thank you! We have your details and will be in touch soon.';
// The same enquiry again inside this window is the send button pressed
// twice, not a second enquiry.
const REPEAT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Checks and trims a website enquiry. Returns { spam: true } for a filled
 * honeypot, otherwise { errors: [...], data: {...} }. A name and one way to
 * reach them is all a lead needs.
 */
function validatePublicLead(body) {
  const b = body && typeof body === 'object' ? body : {};
  const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  // Bots fill every field they find; people never see this one.
  if (str(b.website, 10)) return { spam: true, errors: [], data: null };

  const data = {
    name: str(b.name, 160) || [str(b.firstName, 80), str(b.lastName, 80)].filter(Boolean).join(' '),
    email: str(b.email, 200).toLowerCase(),
    phone: str(b.phone, 40),
    interest: str(b.interest, 200),
    message: str(b.message, 2000),
    // Which page of the website it was sent from, for the note.
    page: str(b.page, 200)
  };
  const errors = [];
  if (!data.name) errors.push('Please tell us your name');
  if (data.email && !EMAIL_RE.test(data.email)) errors.push('Please enter a valid email address');
  if (!data.email && !data.phone) errors.push('Please give an email address or phone number');
  return { spam: false, errors, data };
}

/**
 * A checked website enquiry, into the pipeline: a note on the lead already
 * open for the same person, otherwise a new lead from the website. Never
 * refused for the gym's plan -- nothing about a plan limits leads, and a
 * visitor is not the one who could upgrade it.
 */
async function leadFromEnquiry(data) {
  const summary = [data.interest, data.message].filter(Boolean).join(' — ');
  const text = `Website enquiry${data.page ? ` (${data.page})` : ''}${summary ? `: ${summary}` : ''}`.slice(0, 2000);
  // Somebody who asked is waiting for a reply, so the lead is due for a
  // follow-up today -- stored the way the board's date input stores a day
  // (midnight UTC), which is what puts it on the admin bell's "Lead
  // follow-ups due" and the board's follow-up line.
  const today = new Date(`${T.dateKey()}T00:00:00.000Z`);

  const existing = await openLeadFor(data.email, data.phone);
  if (existing) {
    const last = existing.notes[existing.notes.length - 1];
    const repeat = last && last.text === text && Date.now() - new Date(last.at).getTime() < REPEAT_WINDOW_MS;
    if (!repeat) {
      existing.notes.push({ text, byName: 'Website' });
      existing.lastContactedAt = new Date();
      // Brought forward, never pushed back.
      if (!existing.nextFollowUpAt || new Date(existing.nextFollowUpAt) > today) existing.nextFollowUpAt = today;
      await existing.save();
    }
    return { lead: existing, created: false };
  }

  // Unlike the contact form there is no other record of this enquiry, so it
  // becomes a lead even from somebody who already has an account -- staff
  // are told, and "Make member" links the two.
  const member = data.email ? await User.exists({ email: data.email }) : null;
  const { firstName, lastName } = splitName(data.name);
  const lead = await Lead.create({
    firstName,
    lastName,
    email: data.email,
    phone: data.phone,
    source: 'website',
    interest: data.interest,
    nextFollowUpAt: today,
    notes: [{ text: member ? `${text} (already has an account with this email)` : text, byName: 'Website' }]
  });
  return { lead, created: true };
}

module.exports = {
  leadFromContact,
  validatePublicLead,
  leadFromEnquiry,
  splitName,
  followUpCutoff,
  followUpDueFilter,

  // POST /api/leads/enquiry -- public: the website's enquiry form. Rate
  // limited and honeypot-checked; a bot is thanked and nothing is stored.
  publicEnquiry: async (req, res) => {
    try {
      const result = validatePublicLead(req.body);
      if (result.spam) return res.status(201).json({ success: true, message: ENQUIRY_THANKS });
      if (result.errors.length) return res.status(400).json({ success: false, message: result.errors[0], errors: result.errors });
      await leadFromEnquiry(result.data);
      return res.status(201).json({ success: true, message: ENQUIRY_THANKS });
    } catch (error) {
      console.error('[leads] website enquiry failed:', error);
      return fail(res, 500, 'We could not send your details just now. Please try again in a moment.');
    }
  },

  // GET /admin/leads?status=&search=&due=1&limit=&page=  (or &skip= in place of page)
  //   due=1  only the leads whose follow-up is due (followUpDueFilter) --
  //          where the admin bell's "Lead follow-ups due" links.
  list: async (req, res) => {
    try {
      const due = ['1', 'true'].includes(String(req.query.due || '').toLowerCase());
      const filter = due ? followUpDueFilter() : { isActive: { $ne: false } };
      if (req.query.status && Lead.STATUSES.includes(req.query.status)) {
        // With due=1 a stage narrows the open ones: won and lost are never
        // due, so asking for either finds nothing.
        filter.status = due ? { ...filter.status, $eq: req.query.status } : req.query.status;
      }
      if (req.query.search && String(req.query.search).trim()) {
        // Every word has to match somewhere, so "ann smith" finds Ann Smith
        // although no one field holds both words.
        filter.$and = String(req.query.search)
          .trim()
          .split(/\s+/)
          .slice(0, 5)
          .map((word) => {
            const rx = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            return { $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }, { interest: rx }, { tags: rx }] };
          });
      }
      const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
      // `page` counts from 1; an explicit `skip` wins over it.
      const skipAsked = parseInt(req.query.skip, 10);
      const skip = Number.isFinite(skipAsked) && skipAsked >= 0 ? skipAsked : (Math.max(1, parseInt(req.query.page, 10) || 1) - 1) * limit;
      // _id last so the order is total and a page boundary never shows one
      // lead twice or skips one.
      const [rows, total] = await Promise.all([
        Lead.find(filter).sort({ nextFollowUpAt: 1, createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
        Lead.countDocuments(filter)
      ]);
      const names = await staffNames(rows);
      const counts = await Lead.aggregate([{ $match: { isActive: { $ne: false } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
      return res.json({
        success: true,
        data: rows.map((l) => view(l, names)),
        counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
        pagination: { page: Math.floor(skip / limit) + 1, limit, skip, total, pages: Math.max(1, Math.ceil(total / limit)) }
      });
    } catch (error) {
      console.error('[leads] list failed:', error);
      return fail(res, 500, 'Could not load leads');
    }
  },

  // GET /admin/leads/:id -- one lead, as the list shows it. For a link to a
  // lead (the header search's ?id=) that is not on the board's current page.
  getOne: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Lead not found');
      const lead = await Lead.findOne({ _id: req.params.id, isActive: { $ne: false } }).lean();
      if (!lead) return fail(res, 404, 'Lead not found');
      return res.json({ success: true, data: view(lead, await staffNames([lead])) });
    } catch (error) {
      console.error('[leads] get failed:', error);
      return fail(res, 500, 'Could not load the lead');
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
        // A new member's ID, as every other way of creating one gives.
        await require('../attendance/services/peopleDirectory').assignMemberCode(user);
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
