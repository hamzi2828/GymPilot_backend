// src/attendance/controller/faceController.js
//
// Faces on file for the front desk's webcam (models/faceTemplateModel.js).
//
// The Windows desk, behind the counter -- never the web kiosk (notOnKiosk):
//   POST /api/desktop/face-templates   every face on file, decrypted, to match on the PC
//   POST /api/desktop/face-enroll      register (or replace) one person's face
//   POST /api/desktop/face-remove      take one person's face off file
// The office:
//   GET    /api/attendance/faces                          who has a face on file
//   DELETE /api/attendance/faces/:personType/:personId    take one off
// The person themselves:
//   GET    /api/attendance/me/face    whether theirs is on file
//   DELETE /api/attendance/me/face    withdraw it: theirs is deleted
//
// Consent is asked for every face, every time: nothing is stored unless the
// desk says the person agreed just now, and the moment and the operator are
// kept on the row. Consent to a fingerprint (User.consents.biometric) is a
// different question and is not read or changed here -- but withdrawing it
// removes a face as well (securityController), because the person has said
// no to biometrics.

const mongoose = require('mongoose');

const FaceTemplate = require('../models/faceTemplateModel');
const AttendanceLog = require('../models/attendanceLogModel');
const { resolvePerson, activePersonKeys, trainerProfilesOf, fullName } = require('../services/peopleDirectory');
const { describeOwners, matchesSearch, readPaging } = require('./fingerprintAdminController');

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const PERSON_TYPES = ['member', 'staff'];

function readPerson(source) {
  const personType = String((source && source.person_type) || '').trim();
  const personId = String((source && source.person_id) || '').trim();
  if (!PERSON_TYPES.includes(personType)) return { error: 'Unknown person type.' };
  if (!OBJECT_ID.test(personId)) return { error: 'Unknown person.' };
  return { personType, personId };
}

// One row in the desk's audit trail, under the signed-in desk account.
function deskAudit(req, entry) {
  AttendanceLog.record({
    userId: req.desktopUser._id,
    userName: fullName(req.desktopUser),
    userEmail: req.desktopUser.email,
    device: req.deviceContext.deviceLabel,
    osUser: req.deviceContext.osUser,
    clientApp: req.deviceContext.clientApp,
    ip: req.deviceContext.ip,
    success: true,
    ...entry
  });
}

// The ids a signed-in account's own face could be filed under: the account,
// and any trainer profile linked to it (a face enrolled before the desk
// treated the two as one person).
async function ownIds(userId) {
  const id = new mongoose.Types.ObjectId(String(userId));
  const profiles = await trainerProfilesOf([id]);
  return [id, ...(profiles.get(String(id)) || [])];
}

function shape(entry) {
  return {
    person_type: entry.person_type,
    person_id: entry.person_id,
    name: entry.name,
    code: entry.code,
    record: entry.record,
    status: entry.status,
    count: entry.count,
    readable: entry.readable,
    enrolled_at: entry.enrolled_at,
    consent_at: entry.consent_at,
    enrolled_by_name: entry.enrolled_by_name,
    device: entry.device
  };
}

module.exports = {
  // -------------------------------------------------------------------------
  // The desk
  // -------------------------------------------------------------------------

  // POST /api/desktop/face-templates
  //
  // Every face on file, DECRYPTED, for the signed-in desk PC to match against
  // -- the one place faces leave the server readable, so every call is in the
  // audit trail, as the fingerprint download is. Somebody who has left or
  // been switched off stops matching at once, and their face is not even
  // decrypted; a face filed under a trainer profile that is also a staff
  // account goes out as that account's, the one /people lists.
  faceTemplates: async (req, res) => {
    try {
      const rows = await FaceTemplate.find({ isActive: true, model: FaceTemplate.FACE_MODEL })
        .select('+embeddings personType personId')
        .lean();
      const live = await activePersonKeys(rows);

      const templates = [];
      let unreadable = 0;
      let departed = 0;
      for (const row of rows) {
        const personId = live.get(`${row.personType}:${String(row.personId)}`);
        if (!personId) {
          departed++;
          continue;
        }
        const embeddings = FaceTemplate.decryptEmbeddings(row.embeddings);
        if (!embeddings) {
          // Sealed under a secret this server no longer has: skipped, so one
          // unreadable face never breaks the whole desk.
          unreadable++;
          continue;
        }
        templates.push({ person_type: row.personType, person_id: personId, embeddings });
      }

      deskAudit(req, { event: 'face_template_download', meta: { count: templates.length, unreadable, departed } });
      if (unreadable > 0) {
        console.warn(
          `[attendance] ${unreadable} face template(s) could not be decrypted -- ` +
            'FINGERPRINT_ENCRYPTION_KEY may have changed since they were enrolled.'
        );
      }

      // `unreadable` is said out loud: those people have a face on file that
      // can never match, and the desk can tell them to register again.
      return res.json({ success: true, data: { model: FaceTemplate.FACE_MODEL, templates, unreadable } });
    } catch (err) {
      console.error('[attendance] face templates failed:', err);
      return res.status(500).json({ success: false, message: 'Could not load the faces on file.' });
    }
  },

  // POST /api/desktop/face-enroll
  //   { person_type, person_id, model: 'sface-2021dec', embeddings: number[][], consent: true }
  //
  // A finished template: the desk took the pictures and made the vectors. The
  // person's one face is replaced if they had one.
  faceEnroll: async (req, res) => {
    const body = req.body || {};
    try {
      const who = readPerson(body);
      if (who.error) return res.status(400).json({ success: false, message: who.error });

      // Only `true` itself: a face is never stored on a maybe.
      if (body.consent !== true) {
        return res.status(400).json({
          success: false,
          code: 'CONSENT_REQUIRED',
          message: 'A face is only stored once the person agrees. Ask them, then tick the consent box.'
        });
      }
      if (body.model !== FaceTemplate.FACE_MODEL) {
        return res.status(400).json({
          success: false,
          code: 'BAD_TEMPLATE',
          message: `This desk's face model is not one the server takes (${FaceTemplate.FACE_MODEL}). Update the desk app.`
        });
      }
      const vectors = FaceTemplate.readEmbeddings(body.embeddings);
      if (!vectors) {
        return res.status(400).json({
          success: false,
          code: 'BAD_TEMPLATE',
          message: 'The face scan did not produce a usable template. Try again.'
        });
      }

      const person = await resolvePerson(who.personType, who.personId);
      if (!person) {
        return res.status(404).json({ success: false, message: 'That person is no longer on file.' });
      }

      const now = new Date();
      const operatorName = fullName(req.desktopUser);
      await FaceTemplate.findOneAndUpdate(
        { personType: person.personType, personId: person.id },
        {
          $set: {
            embeddings: FaceTemplate.encryptEmbeddings(vectors),
            model: FaceTemplate.FACE_MODEL,
            count: vectors.length,
            consentAt: now,
            consentBy: req.desktopUser._id,
            enrolledBy: req.desktopUser._id,
            enrolledByName: operatorName,
            device: req.deviceContext.deviceLabel,
            isActive: true
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      // A trainer who is also on the staff enrols as the staff account; a
      // face on file under their trainer profile is the one being replaced.
      if (person.aliasIds && person.aliasIds.length) {
        await FaceTemplate.deleteMany({ personType: person.personType, personId: { $in: person.aliasIds } });
      }

      deskAudit(req, {
        event: 'face_enroll',
        personType: person.personType,
        personId: person.id,
        personName: person.name,
        meta: { count: vectors.length, model: FaceTemplate.FACE_MODEL }
      });

      return res.json({
        success: true,
        message: `Face saved for ${person.name}.`,
        data: { person_type: person.personType, person_id: String(person.id), count: vectors.length }
      });
    } catch (err) {
      console.error('[attendance] face enroll failed:', err);
      return res.status(500).json({ success: false, message: 'Could not save the face.' });
    }
  },

  // POST /api/desktop/face-remove   { person_type, person_id }
  //
  // Asked for at the desk -- the person changed their mind there, or the face
  // was registered to the wrong person. Nothing on file is not an error.
  faceRemove: async (req, res) => {
    try {
      const who = readPerson(req.body);
      if (who.error) return res.status(400).json({ success: false, message: who.error });

      // Whoever the desk knows them as: their face may be filed under their
      // staff account or the trainer profile linked to it.
      const person = await resolvePerson(who.personType, who.personId);
      const ids = new Set([who.personId]);
      if (person) {
        ids.add(String(person.id));
        for (const alias of person.aliasIds || []) ids.add(String(alias));
      }

      const result = await FaceTemplate.deleteMany({ personType: who.personType, personId: { $in: Array.from(ids) } });
      const removed = (result && result.deletedCount) || 0;

      deskAudit(req, {
        event: 'face_remove',
        personType: who.personType,
        personId: person ? person.id : who.personId,
        personName: person ? person.name : '',
        meta: { removed }
      });

      return res.json({
        success: true,
        removed,
        message: removed ? `Face removed${person ? ` for ${person.name}` : ''}.` : 'No face was on file for this person.'
      });
    } catch (err) {
      console.error('[attendance] face remove failed:', err);
      return res.status(500).json({ success: false, message: 'Could not remove the face.' });
    }
  },

  // -------------------------------------------------------------------------
  // The office
  // -------------------------------------------------------------------------

  // GET /api/attendance/faces
  //   ?q=             name, member/staff code, email or phone
  //   ?person_type=   member | staff
  //   ?show=          unreadable | departed   (left out: everyone)
  //   ?page= &limit=
  //
  // Laid out as the fingerprints are (fingerprintAdminController.list): one
  // entry per person, departed owners kept so their faces can be removed,
  // and `summary` over the whole gym whatever the filters. A face is
  // decrypted here only to learn whether it still can be; the vectors never
  // leave this function.
  list: async (req, res) => {
    try {
      const query = req.query || {};
      const term = String(query.q || '').trim().slice(0, 80);
      const type = PERSON_TYPES.includes(query.person_type) ? query.person_type : null;
      const show = String(query.show || '');
      const { page, limit, skip } = readPaging(query, 25, 100);

      const rows = await FaceTemplate.find({})
        .select('+embeddings personType personId model count consentAt enrolledByName device isActive createdAt updatedAt')
        .lean();

      const entries = await describeOwners(
        rows.map((row) => ({
          person_type: row.personType,
          person_id: String(row.personId),
          count: row.count || 0,
          readable: FaceTemplate.decryptEmbeddings(row.embeddings) !== null,
          // Enrolling again replaces the row in place, so its last update is
          // when THIS face was taken.
          enrolled_at: row.updatedAt || row.createdAt || null,
          consent_at: row.consentAt || null,
          enrolled_by_name: row.enrolledByName || '',
          device: row.device || ''
        }))
      );

      const summary = {
        people: entries.length,
        unreadable: entries.filter((entry) => !entry.readable).length,
        departed: entries.filter((entry) => entry.status !== 'active').length
      };

      const filtered = entries.filter((entry) => {
        if (type && entry.person_type !== type) return false;
        if (show === 'unreadable' && entry.readable) return false;
        if (show === 'departed' && entry.status === 'active') return false;
        return matchesSearch(entry, term);
      });
      // By name, with the faces nobody owns any more at the end.
      filtered.sort((a, b) => (a.status === 'missing') - (b.status === 'missing') || a.name.localeCompare(b.name));

      const total = filtered.length;
      return res.json({
        success: true,
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
        summary,
        people: filtered.slice(skip, skip + limit).map(shape)
      });
    } catch (err) {
      console.error('[attendance] face list failed:', err);
      return res.status(500).json({ success: false, message: 'Could not load the faces on file.' });
    }
  },

  // DELETE /api/attendance/faces/:personType/:personId
  //
  // Whatever is on file for that (type, id) -- a member, a staff account, a
  // trainer, or an owner who no longer exists. A desk stops matching it at
  // its next refresh.
  remove: async (req, res) => {
    try {
      const params = req.params || {};
      const who = readPerson({ person_type: params.personType, person_id: params.personId });
      if (who.error) return res.status(400).json({ success: false, message: who.error });

      const result = await FaceTemplate.deleteMany({
        personType: who.personType,
        personId: new mongoose.Types.ObjectId(who.personId)
      });
      const removed = (result && result.deletedCount) || 0;
      if (!removed) {
        return res.status(404).json({ success: false, removed: 0, message: 'No face is on file for this person.' });
      }

      const [person] = await describeOwners([{ person_type: who.personType, person_id: who.personId }]);
      return res.json({
        success: true,
        removed,
        message: `Removed the face on file for ${person.name}. Front desks stop matching it at their next refresh.`
      });
    } catch (err) {
      console.error('[attendance] face removal failed:', err);
      return res.status(500).json({ success: false, message: 'Could not remove the face.' });
    }
  },

  // -------------------------------------------------------------------------
  // The person themselves -- pinned to the signed-in account, no person input
  // -------------------------------------------------------------------------

  // GET /api/attendance/me/face
  mine: async (req, res) => {
    try {
      const row = await FaceTemplate.findOne({ personId: { $in: await ownIds(req.user.id) }, isActive: true })
        .sort({ updatedAt: -1 })
        .select('createdAt updatedAt')
        .lean();
      const at = row ? row.updatedAt || row.createdAt : null;
      return res.json({ success: true, data: { enrolled: !!row, enrolled_at: at ? new Date(at).toISOString() : null } });
    } catch (err) {
      console.error('[attendance] my face failed:', err);
      return res.status(500).json({ success: false, message: 'Could not check your face check-in.' });
    }
  },

  // DELETE /api/attendance/me/face
  //
  // The person withdrawing their consent: their face is deleted, not hidden.
  // In the desk's audit trail, under their own account, since no desk did it.
  removeMine: async (req, res) => {
    try {
      const rows = await FaceTemplate.find({ personId: { $in: await ownIds(req.user.id) } })
        .select('_id personType personId')
        .lean();
      const result = rows.length ? await FaceTemplate.deleteMany({ _id: { $in: rows.map((row) => row._id) } }) : null;
      const removed = (result && result.deletedCount) || 0;

      if (removed) {
        AttendanceLog.record({
          event: 'face_remove',
          userId: req.user.id,
          userEmail: req.user.email || '',
          personType: rows[0].personType,
          personId: rows[0].personId,
          success: true,
          message: 'Withdrawn by the person themselves',
          meta: { removed, self: true }
        });
      }

      return res.json({
        success: true,
        removed,
        message: removed
          ? 'Your face has been deleted. The front desk can no longer recognise you by it.'
          : 'There was no face of yours on file.'
      });
    } catch (err) {
      console.error('[attendance] my face removal failed:', err);
      return res.status(500).json({ success: false, message: 'Could not delete your face. Try again.' });
    }
  }
};
