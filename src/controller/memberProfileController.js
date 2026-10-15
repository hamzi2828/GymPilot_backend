// src/controller/memberProfileController.js
//
// The rest of a member's record beyond name and email: photo, emergency
// contact, health details and the PAR-Q, the signed membership agreement,
// documents, tags and the notes staff keep. The member edits their own
// half from the portal; staff see and edit all of it from Users → Profile.

const mongoose = require('mongoose');
const User = require('../models/user');
const Settings = require('../models/settings');
const { toPublicPath } = require('../helper/upload');
const { membershipFor } = require('../attendance/services/peopleDirectory');
const Attendance = require('../attendance/models/attendanceModel');
const { primaryAddress, oneLine } = require('../services/memberFields');
const guards = require('../services/roleGuards');
const { actorAccess, permissionsFor } = require('../services/roleService');
const verification = require('../services/emailVerification');
const { needsEmail, isStaff } = require('../services/twoFactorService');
const { afterResponse } = require('../services/afterResponse');

const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
const blobUpload = require('../helper/blobUpload');
const { deleteStoredFile } = blobUpload;

const PARQ_QUESTIONS = [
  'Has your doctor ever said that you have a heart condition and that you should only do physical activity recommended by a doctor?',
  'Do you feel pain in your chest when you do physical activity?',
  'In the past month, have you had chest pain when you were not doing physical activity?',
  'Do you lose your balance because of dizziness, or do you ever lose consciousness?',
  'Do you have a bone or joint problem that could be made worse by a change in your physical activity?',
  'Is your doctor currently prescribing drugs for your blood pressure or a heart condition?',
  'Do you know of any other reason why you should not do physical activity?'
];

const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const actorId = (req) => req.user && (req.user.id || req.user._id);
const text = (v, max = 2000) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max));

function fail(res, code, message) {
  return res.status(code).json({ success: false, message });
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

// Who may change whose record. `users: manage` opens these screens, but it
// is the line the Users tab already holds on deleting an account or setting
// its password (services/roleGuards.js) that decides which accounts: an
// administrator's only by an administrator, and nobody's whose role reaches
// further than the actor's own. Your own record is yours to edit.
// Resolves to the sentence to refuse with, or null.
async function reachRefusal(req, target) {
  const actor = await actorAccess(req);
  if (actor.actorId && String(actor.actorId) === String(target._id)) return null;
  if (guards.isAdmin(actor.actorRole)) return null;
  if (guards.isAdmin(target.role)) return "Only an administrator can change an administrator's profile.";
  const wider = guards.widerTab(actor.actorPermissions, await permissionsFor(target.role));
  if (wider) return `This account has more access than yours (${wider}), so ask an administrator to change its profile.`;
  return null;
}

// What staff asked to do to a member's email address: nothing (not sent,
// or the address already there), change it, or remove it. Resolves to
// { change: { email|null } } or { problem: [status, sentence] }. The address
// is the one sign-in, reset and receipt emails go to, so it is checked as
// the account screens check it: one account per address in the gym.
async function emailEdit(req, user, value) {
  if (value === undefined) return {};
  const email = value === null ? '' : String(value).toLowerCase().trim();
  if (email === (user.email || '')) return {};

  // Your own address is changed from your account page, where the password
  // is asked for: whoever controls the address controls the account.
  if (actorId(req) && String(actorId(req)) === String(user._id)) {
    return { problem: [403, 'Change your own email address from your account page.'] };
  }
  if (!email) {
    if (needsEmail(user)) {
      return {
        problem: [409, isStaff(user)
          ? 'Staff accounts keep an email address: two-factor sign-in sends the sign-in code to it.'
          : 'This member has two-factor sign-in on, which sends a code to this address. It cannot be removed while that is on.']
      };
    }
    if (user.provider === 'google' || user.googleId || !user.password) {
      return { problem: [409, 'This member signs in with Google using this address, so it cannot be removed.'] };
    }
    return { change: { email: null } };
  }
  if (email.length > 254 || !verification.looksLikeEmail(email)) {
    return { problem: [400, `"${String(value).trim()}" is not a valid email address.`] };
  }
  const owner = await User.findOne({ email, _id: { $ne: user._id } }).select('firstName lastName memberCode username').lean();
  if (owner) {
    const who = [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.username || 'another account';
    return { problem: [409, `${email} is already used by ${who}${owner.memberCode ? ` (${owner.memberCode})` : ''}. Each account needs its own email address.`] };
  }
  return { change: { email } };
}

async function waiverSettings() {
  try {
    const settings = await Settings.getSettings();
    const w = (settings && settings.membership && settings.membership.waiver) || {};
    return { required: !!w.required, version: String(w.version || '1.0'), text: String(w.text || '') };
  } catch {
    return { required: false, version: '1.0', text: '' };
  }
}

function waiverStatus(user, config) {
  const signed = user.waiver && user.waiver.signedAt ? { signedAt: user.waiver.signedAt, version: user.waiver.version || '', signature: user.waiver.signature || '', source: user.waiver.source || '' } : null;
  const current = !!(signed && signed.version === config.version);
  return { signed, needs_signature: !!(config.required && config.text && !current) };
}

function healthView(user) {
  const ec = user.emergencyContact || {};
  const med = user.medical || {};
  const parq = med.parq || {};
  return {
    emergencyContact: { name: ec.name || '', phone: ec.phone || '', relationship: ec.relationship || '' },
    medical: {
      conditions: med.conditions || '',
      medications: med.medications || '',
      injuries: med.injuries || '',
      parq: { completedAt: parq.completedAt || null, answers: parq.answers || [], flagged: !!parq.flagged }
    }
  };
}

function applyEmergencyContact(user, input) {
  if (!input || typeof input !== 'object') return;
  user.emergencyContact = {
    name: text(input.name, 120) ?? (user.emergencyContact && user.emergencyContact.name) ?? '',
    phone: text(input.phone, 40) ?? (user.emergencyContact && user.emergencyContact.phone) ?? '',
    relationship: text(input.relationship, 60) ?? (user.emergencyContact && user.emergencyContact.relationship) ?? ''
  };
}

function applyMedical(user, input) {
  if (!input || typeof input !== 'object') return;
  user.medical = user.medical || {};
  for (const key of ['conditions', 'medications', 'injuries', 'notes']) {
    const value = text(input[key]);
    if (value !== undefined) user.medical[key] = value;
  }
}

function applyParq(user, input) {
  if (!input || !Array.isArray(input.answers)) return;
  const answers = PARQ_QUESTIONS.map((question, i) => ({ question, answer: input.answers[i] === true || input.answers[i] === 'true' }));
  user.medical = user.medical || {};
  user.medical.parq = { completedAt: new Date(), answers, flagged: answers.some((a) => a.answer) };
}

async function storeUpload(file, folder) {
  if (USE_BLOB_STORAGE) {
    return blobUpload.uploadToBlob(file.buffer, file.originalname, file.mimetype, folder);
  }
  return toPublicPath(file.filename);
}

async function setPhoto(user, file) {
  const url = await storeUpload(file, 'members');
  const old = user.avatarUrl;
  user.avatarUrl = url;
  await user.save();
  // The photo it replaces goes too, wherever it was stored. One that is not
  // this gym's own upload (a Google picture) is left alone by the helper.
  if (old && old !== url) await deleteStoredFile(old, 'members');
  return url;
}

module.exports = {
  PARQ_QUESTIONS,

  // ---- member ---------------------------------------------------------------

  // GET /user/health
  myHealth: async (req, res) => {
    try {
      const user = await User.findById(actorId(req)).select('emergencyContact medical').lean();
      if (!user) return fail(res, 404, 'Account not found');
      return res.json({ success: true, data: healthView(user), questions: PARQ_QUESTIONS });
    } catch (error) {
      console.error('[profile] health failed:', error);
      return fail(res, 500, 'Could not load your health details');
    }
  },

  // PUT /user/health   { emergencyContact, medical: {conditions, medications, injuries}, parq: { answers } }
  setMyHealth: async (req, res) => {
    try {
      // `medical` is `select: false`: it has to be loaded to be edited in
      // place, or the merge below would start from empty and drop the rest.
      const user = await User.findById(actorId(req)).select('+medical');
      if (!user) return fail(res, 404, 'Account not found');
      const body = req.body || {};
      applyEmergencyContact(user, body.emergencyContact);
      // The member fills in their own conditions; the staff-only notes field
      // is not theirs to write.
      if (body.medical && typeof body.medical === 'object') applyMedical(user, { conditions: body.medical.conditions, medications: body.medical.medications, injuries: body.medical.injuries });
      applyParq(user, body.parq);
      await user.save();
      return res.json({ success: true, message: 'Saved.', data: healthView(user) });
    } catch (error) {
      console.error('[profile] set health failed:', error);
      return fail(res, 500, 'Could not save your health details');
    }
  },

  // GET /user/waiver
  myWaiver: async (req, res) => {
    try {
      const [user, config] = await Promise.all([User.findById(actorId(req)).select('waiver').lean(), waiverSettings()]);
      if (!user) return fail(res, 404, 'Account not found');
      return res.json({ success: true, data: { ...config, ...waiverStatus(user, config) } });
    } catch (error) {
      console.error('[profile] waiver failed:', error);
      return fail(res, 500, 'Could not load the agreement');
    }
  },

  // POST /user/waiver/sign   { signature, agreed }
  signWaiver: async (req, res) => {
    try {
      const { signature, agreed } = req.body || {};
      if (!(agreed === true || agreed === 'true')) return fail(res, 400, 'Tick the box to agree');
      const name = text(signature, 120);
      if (!name || name.length < 3) return fail(res, 400, 'Type your full name to sign');
      const config = await waiverSettings();
      if (!config.text) return fail(res, 409, 'There is no agreement to sign');
      const user = await User.findById(actorId(req));
      if (!user) return fail(res, 404, 'Account not found');
      user.waiver = { signedAt: new Date(), version: config.version, signature: name, source: 'portal', ip: clientIp(req), recordedBy: null };
      await user.save();
      return res.json({ success: true, message: 'Thank you — your agreement is signed.', data: { ...config, ...waiverStatus(user, config) } });
    } catch (error) {
      console.error('[profile] sign waiver failed:', error);
      return fail(res, 500, 'Could not record your signature');
    }
  },

  // POST /user/photo   (multipart: photo)
  setMyPhoto: async (req, res) => {
    try {
      if (!req.file) return fail(res, 400, 'Choose an image');
      const user = await User.findById(actorId(req));
      if (!user) return fail(res, 404, 'Account not found');
      const url = await setPhoto(user, req.file);
      return res.json({ success: true, message: 'Photo updated.', data: { avatarUrl: url } });
    } catch (error) {
      console.error('[profile] photo failed:', error);
      return fail(res, 500, 'Could not save the photo');
    }
  },

  // ---- staff ------------------------------------------------------------------

  // GET /admin/users/tags
  tags: async (req, res) => {
    try {
      const tags = await User.distinct('tags');
      return res.json({ success: true, data: tags.filter(Boolean).sort() });
    } catch (error) {
      return fail(res, 500, 'Could not load tags');
    }
  },

  // GET /admin/users/:id/profile
  profile: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Member not found');
      // This is the staff view of the whole record, so the `select: false`
      // blocks are asked for by name.
      const user = await User.findById(req.params.id).select('-password +medical +staffNotes +documents').lean();
      if (!user) return fail(res, 404, 'Member not found');
      const [membership, lastVisit, config] = await Promise.all([
        membershipFor(user).catch(() => null),
        Attendance.findOne({ personId: user._id }).sort({ checkInAt: -1 }).select('checkInAt shiftDate').lean().catch(() => null),
        waiverSettings()
      ]);
      return res.json({
        success: true,
        data: {
          id: String(user._id),
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone || '',
          // The one line the desk typed (the account's primary address).
          address: primaryAddress(user),
          dateOfBirth: user.dateOfBirth || null,
          gender: user.gender || '',
          avatarUrl: user.avatarUrl || '',
          role: user.role,
          isActive: user.isActive !== false,
          memberCode: user.memberCode || '',
          tags: user.tags || [],
          goals: user.goals || '',
          source: user.source || '',
          assignedTrainerId: user.assignedTrainerId ? String(user.assignedTrainerId) : null,
          staffNotes: user.staffNotes || '',
          createdAt: user.createdAt,
          lastLogin: user.lastLogin || null,
          consents: user.consents || {},
          notificationPreferences: user.notificationPreferences || {},
          ...healthView(user),
          medicalNotes: (user.medical && user.medical.notes) || '',
          waiver: { ...config, ...waiverStatus(user, config) },
          documents: (user.documents || []).map((d) => ({ id: String(d._id), name: d.name, url: d.url, mimeType: d.mimeType, size: d.size, uploadedAt: d.uploadedAt })),
          membership: membership || null,
          lastVisit: lastVisit ? lastVisit.checkInAt || lastVisit.shiftDate : null
        }
      });
    } catch (error) {
      console.error('[profile] admin profile failed:', error);
      return fail(res, 500, 'Could not load the member');
    }
  },

  // PUT /admin/users/:id/profile
  updateProfile: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Member not found');
      // Health details are merged field by field, so they must be loaded.
      const user = await User.findById(req.params.id).select('+medical +staffNotes');
      if (!user) return fail(res, 404, 'Member not found');
      const refusal = await reachRefusal(req, user);
      if (refusal) return fail(res, 403, refusal);
      const body = req.body || {};
      const reachable = !!(user.email || user.phone);
      const previousEmail = user.email || null;

      // Checked before anything is changed, so a refusal saves nothing.
      for (const [key, label] of [['firstName', 'First name'], ['lastName', 'Last name']]) {
        if (body[key] !== undefined && !text(body[key], 80)) return fail(res, 400, `${label} cannot be left empty.`);
      }
      const emailResult = await emailEdit(req, user, body.email);
      if (emailResult.problem) return fail(res, ...emailResult.problem);

      for (const key of ['firstName', 'lastName']) {
        const value = text(body[key], 80);
        if (value) user[key] = value;
      }
      if (body.phone !== undefined) user.phone = text(body.phone, 40) || null;
      if (emailResult.change) {
        // Typed by staff for the member in front of them: vouched for, as an
        // account the desk creates is (services/emailVerification.js). Links
        // already out -- a reset, a confirmation -- went to the old address
        // and stop working with it.
        user.email = emailResult.change.email || undefined;
        user.emailVerified = true;
        user.emailVerifyTokenHash = null;
        user.emailVerifyExpiresAt = null;
        user.passwordResetTokenHash = null;
        user.passwordResetExpiresAt = null;
      }
      // A member needs one way to be reached and found: an email or a phone.
      if (user.role === 'user' && reachable && !user.email && !user.phone) {
        return fail(res, 400, emailResult.change ? 'Add a phone number before removing the email address: the gym needs one way to reach them.' : 'A member without an email address needs a phone number.');
      }
      if (body.address !== undefined) {
        // The primary address's line, kept in the member's own address book
        // (addresses[]) rather than a second field that could disagree with it.
        const line = oneLine(text(body.address, 300));
        const entry = (user.addresses || []).find((a) => a.isDefault) || (user.addresses || []).find((a) => a.label === 'primary');
        if (entry) entry.address = line;
        else if (line) user.addresses.push({ label: 'primary', isDefault: true, address: line });
      }
      if (body.gender !== undefined) user.gender = text(body.gender, 20) || null;
      if (body.dateOfBirth !== undefined) {
        const d = body.dateOfBirth ? new Date(body.dateOfBirth) : null;
        user.dateOfBirth = d && !Number.isNaN(d.getTime()) ? d : null;
      }
      if (Array.isArray(body.tags)) user.tags = [...new Set(body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 30);
      if (body.goals !== undefined) user.goals = text(body.goals) || '';
      if (body.source !== undefined) user.source = text(body.source, 120) || '';
      if (body.assignedTrainerId !== undefined) user.assignedTrainerId = isId(body.assignedTrainerId) ? body.assignedTrainerId : null;
      if (body.staffNotes !== undefined) user.staffNotes = text(body.staffNotes, 10000) || '';
      applyEmergencyContact(user, body.emergencyContact);
      applyMedical(user, body.medical);
      if (body.medicalNotes !== undefined) {
        user.medical = user.medical || {};
        user.medical.notes = text(body.medicalNotes) || '';
      }
      await user.save();

      let message = 'Profile saved.';
      if (emailResult.change) {
        // The address it was is told: if this was not what the member
        // wanted, that message is how they find out.
        if (previousEmail) afterResponse(() => verification.sendChangeNotice(previousEmail, user, { removed: !user.email }), 'email change notice');
        message = user.email
          ? `Profile saved. Their email address is now ${user.email}.`
          : `Profile saved. Their email address was removed: they sign in with their username${user.username ? `, ${user.username},` : ''} from now on.`;
      }
      return res.json({ success: true, message, data: { email: user.email || null, phone: user.phone || '' } });
    } catch (error) {
      // Another account took the address in the moment between the check and the save.
      if (error && error.code === 11000) return fail(res, 409, 'That email address is already used by another account.');
      console.error('[profile] admin update failed:', error);
      return fail(res, 500, 'Could not save the profile');
    }
  },

  // POST /admin/users/:id/photo   (multipart: photo)
  setPhoto: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Member not found');
      if (!req.file) return fail(res, 400, 'Choose an image');
      const user = await User.findById(req.params.id);
      if (!user) return fail(res, 404, 'Member not found');
      const refusal = await reachRefusal(req, user);
      if (refusal) return fail(res, 403, refusal);
      const url = await setPhoto(user, req.file);
      return res.json({ success: true, message: 'Photo updated.', data: { avatarUrl: url } });
    } catch (error) {
      console.error('[profile] admin photo failed:', error);
      return fail(res, 500, 'Could not save the photo');
    }
  },

  // POST /admin/users/:id/documents   (multipart: file, name)
  addDocument: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Member not found');
      if (!req.file) return fail(res, 400, 'Choose a file');
      // The list is appended to, so it has to be loaded (`select: false`).
      const user = await User.findById(req.params.id).select('+documents');
      if (!user) return fail(res, 404, 'Member not found');
      const refusal = await reachRefusal(req, user);
      if (refusal) return fail(res, 403, refusal);
      if ((user.documents || []).length >= 50) return fail(res, 409, 'This member already has 50 documents');
      const url = await storeUpload(req.file, 'member-documents');
      user.documents = user.documents || [];
      user.documents.push({
        name: text((req.body || {}).name, 120) || req.file.originalname || 'Document',
        url,
        mimeType: req.file.mimetype || '',
        size: req.file.size || 0,
        uploadedAt: new Date(),
        uploadedBy: actorId(req)
      });
      await user.save();
      const doc = user.documents[user.documents.length - 1];
      return res.status(201).json({ success: true, message: 'Document added.', data: { id: String(doc._id), name: doc.name, url: doc.url, mimeType: doc.mimeType, size: doc.size, uploadedAt: doc.uploadedAt } });
    } catch (error) {
      console.error('[profile] add document failed:', error);
      return fail(res, 500, 'Could not add the document');
    }
  },

  // DELETE /admin/users/:id/documents/:docId
  removeDocument: async (req, res) => {
    try {
      if (!isId(req.params.id) || !isId(req.params.docId)) return fail(res, 404, 'Document not found');
      const user = await User.findById(req.params.id).select('+documents');
      if (!user) return fail(res, 404, 'Member not found');
      const refusal = await reachRefusal(req, user);
      if (refusal) return fail(res, 403, refusal);
      const doc = (user.documents || []).find((d) => String(d._id) === String(req.params.docId));
      if (!doc) return fail(res, 404, 'Document not found');
      const url = doc.url;
      user.documents = user.documents.filter((d) => String(d._id) !== String(req.params.docId));
      await user.save();
      await deleteStoredFile(url, 'member-documents');
      return res.json({ success: true, message: 'Document removed.' });
    } catch (error) {
      console.error('[profile] remove document failed:', error);
      return fail(res, 500, 'Could not remove the document');
    }
  },

  // POST /admin/users/:id/waiver   { signature }  -- signed on paper at the desk
  recordWaiver: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 404, 'Member not found');
      const user = await User.findById(req.params.id);
      if (!user) return fail(res, 404, 'Member not found');
      const refusal = await reachRefusal(req, user);
      if (refusal) return fail(res, 403, refusal);
      const config = await waiverSettings();
      const name = text((req.body || {}).signature, 120) || [user.firstName, user.lastName].filter(Boolean).join(' ');
      user.waiver = { signedAt: new Date(), version: config.version, signature: name, source: 'desk', ip: clientIp(req), recordedBy: actorId(req) };
      await user.save();
      // By email as always -- or, for a member who has none, by name or
      // username (as securityController.labelOf does), never "undefined".
      const who = user.email || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'this member';
      return res.json({ success: true, message: `Agreement recorded for ${who}.`, data: { ...config, ...waiverStatus(user, config) } });
    } catch (error) {
      console.error('[profile] record waiver failed:', error);
      return fail(res, 500, 'Could not record the agreement');
    }
  }
};
