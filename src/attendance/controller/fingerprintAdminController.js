// src/attendance/controller/fingerprintAdminController.js
//
// The admin panel's view of every fingerprint on file, and the one place a
// finger can be taken off it. The front desk can link a finger
// (/api/desktop/enroll) but never unlink one, and until this existed the only
// way to remove a finger, short of deleting the person, was withdrawing their
// consent -- which works for User accounts only. A finger linked to the wrong
// person, or to two people before the desk checked for duplicates, had no way
// out.
//
//   GET    /api/attendance/fingerprints                              who has fingers on file
//   DELETE /api/attendance/fingerprints/:personType/:personId        every finger of one person
//   DELETE /api/attendance/fingerprints/:personType/:personId/:finger   just that one
//          (or ...:personId?finger=N)
//
// Mounted from routes/allRoutes.js, not the read-only attendance router: this
// one deletes.
//
// Consent is left exactly as it was. Consent answers "may the gym store my
// fingerprint", and removing a finger that was linked to the wrong person, or
// that can no longer be read, does not change that answer -- the next step is
// usually registering the right finger straight away, and the desk would
// otherwise have to ask again for a signature the person already gave.
// Withdrawing consent (controller/securityController.js) is the route that
// removes both, because there the person HAS changed their answer.

const mongoose = require('mongoose');

const Fingerprint = require('../models/fingerprintModel');
const User = require('../../models/user');
const Trainer = require('../../gymfolio/models/trainerModel');
const { fullName } = require('../services/peopleDirectory');

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const PERSON_TYPES = ['member', 'staff'];

// 1-indexed and in the same order as FingerNames.All in the desktop app: the
// finger_index the desk sends is a position in that list.
const FINGER_NAMES = [
  'Right Thumb', 'Right Index', 'Right Middle', 'Right Ring', 'Right Little',
  'Left Thumb', 'Left Index', 'Left Middle', 'Left Ring', 'Left Little'
];

function fingerName(index) {
  return FINGER_NAMES[index - 1] || `Finger ${index}`;
}

function toObjectId(value) {
  return new mongoose.Types.ObjectId(String(value));
}

function readPaging(query, defaultLimit, maxLimit) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Which finger a removal is about: `{ index: null }` for every finger (none
 * given), `{ index: n }` for finger n, or null when what was given is not a
 * finger at all -- which must be refused, not read as "all of them".
 */
function readFinger(value) {
  if (value === undefined || value === null || String(value).trim() === '') return { index: null };
  const text = String(value).trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  const index = Number(text);
  return index >= 1 && index <= 10 ? { index } : null;
}

// One entry per person, fingers in finger order. A template is decrypted here
// only to learn whether it still CAN be -- the plaintext is dropped on the
// spot and never leaves this function. An unreadable finger (encrypted under
// a key this server no longer has) is left out of every desk's download, so
// it can never match; it is listed so it can be removed and re-registered.
function groupFingers(rows) {
  const people = new Map();

  for (const row of rows) {
    const key = `${row.personType}:${String(row.personId)}`;
    let entry = people.get(key);
    if (!entry) {
      entry = { person_type: row.personType, person_id: String(row.personId), fingers: [] };
      people.set(key, entry);
    }

    entry.fingers.push({
      finger_index: row.fingerIndex,
      finger_name: fingerName(row.fingerIndex),
      readable: Fingerprint.decryptTemplate(row.template) !== null,
      active: row.isActive !== false,
      // Re-registering a finger replaces the row in place (see /enroll), so
      // the last update is when THIS template was captured.
      enrolled_at: row.updatedAt || row.createdAt || null,
      enrolled_by: row.enrolledByName || '',
      device: row.enrolledDevice || ''
    });
  }

  const groups = Array.from(people.values());
  for (const group of groups) {
    group.fingers.sort((a, b) => a.finger_index - b.finger_index);
    group.unreadable = group.fingers.filter((finger) => !finger.readable).length;
  }
  return groups;
}

// Who a group belongs to, read the way peopleDirectory.resolvePerson reads it:
// a member is a User; staff is a Trainer or, failing that, a User who works
// here. Unlike the desk, someone who has left or been switched off is still
// listed -- their fingers are still on file, and those are exactly the ones an
// admin may want gone. `status` says whether the desk still matches them.
function ownerOf(group, users, trainers) {
  if (group.person_type === 'staff') {
    const trainer = trainers.get(group.person_id);
    if (trainer) {
      return {
        name: trainer.name || 'Trainer',
        code: trainer.staffCode || '',
        record: 'trainer',
        status: trainer.isActive === true ? 'active' : 'inactive',
        haystack: [trainer.name, trainer.staffCode, trainer.email, trainer.phone]
      };
    }
    const user = users.get(group.person_id);
    if (user) {
      const working = user.isActive === true && !!(user.employment && user.employment.isStaff);
      return {
        name: fullName(user),
        code: user.staffCode || '',
        record: 'user',
        status: working ? 'active' : 'inactive',
        haystack: [fullName(user), user.staffCode, user.email, user.phone]
      };
    }
  } else {
    const user = users.get(group.person_id);
    if (user) {
      return {
        name: fullName(user),
        code: user.memberCode || '',
        record: 'user',
        status: user.isActive === true ? 'active' : 'inactive',
        haystack: [fullName(user), user.memberCode, user.email, user.phone]
      };
    }
  }

  // A finger whose owner is gone. Deleting a person removes their fingers,
  // but that clean-up is allowed to fail without blocking the deletion.
  return {
    name: group.person_type === 'staff' ? 'Deleted staff record' : 'Deleted member',
    code: '',
    record: null,
    status: 'missing',
    haystack: []
  };
}

/** Fills in name, code, record and status on each group, in two queries. */
async function describeOwners(groups) {
  const memberIds = [];
  const staffIds = [];
  for (const group of groups) {
    if (!OBJECT_ID.test(group.person_id)) continue;
    (group.person_type === 'staff' ? staffIds : memberIds).push(group.person_id);
  }

  const userIds = memberIds.concat(staffIds);
  const [users, trainers] = await Promise.all([
    userIds.length
      ? User.find({ _id: { $in: userIds } })
          .select('firstName lastName email phone memberCode staffCode isActive employment.isStaff')
          .lean()
      : [],
    staffIds.length
      ? Trainer.find({ _id: { $in: staffIds } }).select('name email phone staffCode isActive').lean()
      : []
  ]);

  const userIndex = new Map(users.map((user) => [String(user._id), user]));
  const trainerIndex = new Map(trainers.map((trainer) => [String(trainer._id), trainer]));

  for (const group of groups) Object.assign(group, ownerOf(group, userIndex, trainerIndex));
  return groups;
}

function matchesSearch(group, term) {
  if (!term) return true;
  const wanted = term.toLowerCase();
  return group.haystack.some((value) => value && String(value).toLowerCase().includes(wanted));
}

function shape(group) {
  return {
    person_type: group.person_type,
    person_id: group.person_id,
    name: group.name,
    code: group.code,
    record: group.record,
    status: group.status,
    unreadable: group.unreadable,
    fingers: group.fingers
  };
}

module.exports = {
  FINGER_NAMES,
  fingerName,
  readFinger,
  groupFingers,

  // -------------------------------------------------------------------------
  // GET /api/attendance/fingerprints
  //   ?q=             name, member/staff code, email or phone
  //   ?person_type=   member | staff
  //   ?show=          unreadable | departed   (left out: everyone)
  //   ?page= &limit=
  //
  // Every row on file is read, template included, because "can it still be
  // decrypted" is the question this screen is for -- it is the same set each
  // front desk downloads every few minutes. `summary` covers the whole gym
  // whatever the filters, so an unreadable finger is visible from page one.
  // -------------------------------------------------------------------------
  list: async (req, res) => {
    try {
      const query = req.query || {};
      const term = String(query.q || '').trim().slice(0, 80);
      const type = PERSON_TYPES.includes(query.person_type) ? query.person_type : null;
      const show = String(query.show || '');
      const { page, limit, skip } = readPaging(query, 25, 100);

      const rows = await Fingerprint.find({})
        .select('+template personType personId fingerIndex isActive enrolledByName enrolledDevice createdAt updatedAt')
        .lean();

      const groups = await describeOwners(groupFingers(rows));

      const summary = {
        people: groups.length,
        fingers: rows.length,
        unreadable: groups.reduce((sum, group) => sum + group.unreadable, 0),
        departed: groups.filter((group) => group.status !== 'active').length
      };

      const filtered = groups.filter((group) => {
        if (type && group.person_type !== type) return false;
        if (show === 'unreadable' && group.unreadable === 0) return false;
        if (show === 'departed' && group.status === 'active') return false;
        return matchesSearch(group, term);
      });

      // By name, with the fingers nobody owns any more at the end.
      filtered.sort(
        (a, b) => (a.status === 'missing') - (b.status === 'missing') || a.name.localeCompare(b.name)
      );

      const total = filtered.length;
      return res.json({
        success: true,
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
        summary,
        people: filtered.slice(skip, skip + limit).map(shape)
      });
    } catch (err) {
      console.error('[attendance] fingerprint list failed:', err);
      return res.status(500).json({ success: false, message: 'Could not load the fingerprints on file.' });
    }
  },

  // -------------------------------------------------------------------------
  // DELETE /api/attendance/fingerprints/:personType/:personId[/:finger]
  //
  // The finger may also come as ?finger=N. The admin panel uses the path
  // form: the audit trail records the path without its query string, and it
  // should say which finger went.
  //
  // Works on whatever is on file for that (type, id) pair -- a member, a
  // staff account, a Trainer, or an owner who no longer exists. A desk stops
  // matching the finger at its next template refresh.
  // -------------------------------------------------------------------------
  remove: async (req, res) => {
    try {
      const params = req.params || {};
      const personType = String(params.personType || '');
      const personId = String(params.personId || '');

      if (!PERSON_TYPES.includes(personType)) {
        return res.status(400).json({ success: false, message: 'Unknown person type.' });
      }
      if (!OBJECT_ID.test(personId)) {
        return res.status(400).json({ success: false, message: 'Invalid person id.' });
      }

      const finger = readFinger(params.finger !== undefined ? params.finger : (req.query || {}).finger);
      if (!finger) {
        return res.status(400).json({
          success: false,
          message: 'Pick a finger from 1 to 10, or leave it out to remove every finger.'
        });
      }

      const owner = { personType, personId: toObjectId(personId) };
      const filter = finger.index ? Object.assign({ fingerIndex: finger.index }, owner) : owner;

      const result = await Fingerprint.deleteMany(filter);
      const removed = (result && result.deletedCount) || 0;

      if (!removed) {
        return res.status(404).json({
          success: false,
          message: finger.index
            ? `No ${fingerName(finger.index).toLowerCase()} is on file for this person.`
            : 'No fingerprints are on file for this person.'
        });
      }

      const [remaining, [person]] = await Promise.all([
        Fingerprint.countDocuments(owner),
        describeOwners([{ person_type: personType, person_id: personId }])
      ]);

      const what = finger.index
        ? `${person.name}'s ${fingerName(finger.index).toLowerCase()}`
        : `${removed} fingerprint${removed === 1 ? '' : 's'} from ${person.name}`;

      return res.json({
        success: true,
        message: `Removed ${what}. Front desks stop matching ${removed === 1 ? 'it' : 'them'} at their next refresh.`,
        data: {
          person_type: personType,
          person_id: personId,
          name: person.name,
          finger_index: finger.index,
          removed,
          remaining
        }
      });
    } catch (err) {
      console.error('[attendance] fingerprint removal failed:', err);
      return res.status(500).json({ success: false, message: 'Could not remove the fingerprint.' });
    }
  }
};
