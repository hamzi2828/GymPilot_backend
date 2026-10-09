// src/attendance/controller/desktopAppController.js
//
// The API surface the front-desk attendance app talks to. Everything lives
// under /api/desktop and is POST -- the desktop client speaks one verb, which
// keeps its HTTP layer to a single method.
//
// Note the split of work: this server never sees a fingerprint SCAN. The PC
// downloads the enrolled templates once (`templates`), matches locally, and
// posts only the resolved person to `punch`. See the desktop app's README for
// why matching is not done here.

const bcrypt = require('bcryptjs');

const User = require('../../models/user');
const DesktopToken = require('../models/desktopTokenModel');
const Fingerprint = require('../models/fingerprintModel');
const Attendance = require('../models/attendanceModel');
const AttendanceLog = require('../models/attendanceLogModel');

const { deviceContext, issueStaffUnlock } = require('../middleware/desktopAuth');
const { listPeople, resolvePerson, activePersonKeys, trainerProfilesOf } = require('../services/peopleDirectory');
const { currentPalette } = require('../services/deskTheme');
const { recordPunch, currentVerdict } = require('../services/punchService');
const { openVisitExpr, isOpenVisit, missedCheckOut } = require('../services/staleVisits');
const T = require('../services/timeUtils');
const { verifyQrToken } = require('../services/qrToken');
const { findByCode } = require('../services/peopleDirectory');
const { tenantKey } = require('../../platform/tenantContext');
const { loginFilter } = require('../../services/username');
const signInLock = require('../../services/signInLock');

// One answer for a wrong password, a name nobody has, an account switched
// off and one whose password is paused, in the website's words.
const SIGN_IN_REJECTED = `That email or username and password do not match. ${signInLock.PAUSE_NOTE}`;

// The 1:N false-accept target the desktop matcher scales by candidate count.
// 1-in-100,000 is the DigitalPersona default and what the reference reader
// app uses.
const FAR_DENOMINATOR = Number(process.env.FINGERPRINT_FAR || 100000);

// ---------------------------------------------------------------------------
// Login throttling
//
// Held in memory, so on a serverless deployment it is per-instance rather
// than global -- it raises the cost of a guessing run without pretending to
// be a complete defence. The real control is that desktop app access is
// off by default on every account. Behind it, every password typed at the
// sign-in window also uses one of the account's ten tries, kept in the
// database and shared with the website and the phone app
// (services/signInLock.js).
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map();

// Failures count against the account, whichever way it was named -- its
// email or its username, in any case or spacing -- so switching between
// them buys no extra guesses. A name that matches no account counts against
// itself, as normalised by loginFilter.
function attemptKey(user, filter, ip) {
  const who = user ? `account:${user._id}` : `name:${filter.email || filter.username}`;
  // Scoped to the gym: the same address at two gyms is two accounts.
  return `${tenantKey()}|${who}|${ip || ''}`;
}

function isThrottled(key) {
  const entry = attempts.get(key);
  if (!entry) return false;

  if (Date.now() - entry.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function noteFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
    return;
  }
  entry.count += 1;
}

function clearFailures(key) {
  attempts.delete(key);
}

// Opportunistic sweep so a long-running instance does not accumulate keys for
// every address that ever mistyped a password.
setInterval(() => {
  const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
  for (const [key, entry] of attempts) if (entry.first < cutoff) attempts.delete(key);
}, ATTEMPT_WINDOW_MS).unref?.();

// ---------------------------------------------------------------------------

function sessionPayload(user) {
  return {
    id: String(user._id),
    name: [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email,
    username: user.email,
    location: user.attendanceLocation || '',
    can_enroll: Boolean(user.allowFingerprintEnrollment)
  };
}

module.exports = {
  // POST /api/desktop/theme
  //
  // Unauthenticated on purpose: the SIGN-IN window needs the palette too, and
  // it has no token yet. The colour scheme is already public -- /settings/public
  // serves it to every visitor of the website -- so this exposes nothing new.
  theme: async (req, res) => {
    return res.json({ success: true, theme: await currentPalette() });
  },

  // POST /api/desktop/login
  //
  // Same email (or username) and password staff already use on the website
  // -- there is no separate credential store. What differs is the grant: an account without
  // allowAttendanceApp is refused with 403 even when the password is right,
  // so the desk is told to ask an admin rather than retyping it.
  login: async (req, res) => {
    const device = deviceContext(req);
    const { email, password } = req.body || {};

    try {
      // An email or a username, as the website's sign-in takes them. Spaces
      // alone name nobody.
      const filter = loginFilter(email);
      if (!filter || !password) {
        return res.status(400).json({ success: false, message: 'Enter your email or username and password.' });
      }

      const user = await User.findOne(filter);

      const key = attemptKey(user, filter, device.ip);
      if (isThrottled(key)) {
        return res.status(429).json({
          success: false,
          message: 'Too many failed sign-ins. Wait a few minutes and try again.'
        });
      }

      // One of the account's ten tries, as on the website and the phone
      // app: after ten wrong ones the password is not checked for fifteen
      // minutes, wherever they were typed. The same bcrypt work is done for
      // a name nobody has, so it is not answered faster (signInLock.js).
      const matches = await signInLock.signInPasswordMatches(user, password);
      if (!matches || !user.isActive) {
        noteFailure(key);
        return res.status(401).json({ success: false, message: SIGN_IN_REJECTED });
      }

      if (!user.allowAttendanceApp) {
        // Not a failed sign-in -- do not count it toward the throttle, or a
        // confused operator locks out an account that would never work.
        AttendanceLog.record({
          event: 'login_denied',
          userId: user._id,
          userName: sessionPayload(user).name,
          userEmail: user.email,
          success: false,
          message: 'Account lacks allowAttendanceApp',
          device: device.deviceLabel,
          osUser: device.osUser,
          clientApp: device.clientApp,
          ip: device.ip
        });

        return res.status(403).json({
          success: false,
          message: 'This account is not allowed to use the attendance app.'
        });
      }

      clearFailures(key);

      const { token, expiresAt } = await DesktopToken.issue(user._id, device);

      user.lastLogin = new Date();
      await user.save();

      AttendanceLog.record({
        event: 'login',
        userId: user._id,
        userName: sessionPayload(user).name,
        userEmail: user.email,
        success: true,
        device: device.deviceLabel,
        osUser: device.osUser,
        clientApp: device.clientApp,
        ip: device.ip
      });

      return res.json({
        success: true,
        token,
        theme: await currentPalette(),
        // The app parses this with DateTime.Parse, so it must be an
        // unambiguous absolute instant.
        expires_at: expiresAt.toISOString(),
        user: sessionPayload(user)
      });
    } catch (err) {
      console.error('[attendance] login failed:', err);
      return res.status(500).json({ success: false, message: 'Sign in failed. Try again.' });
    }
  },

  // POST /api/desktop/session
  //
  // Called on resume from a saved token and by "Refresh list", so a
  // permission granted or withdrawn on the website lands without a restart.
  session: async (req, res) => {
    // The theme rides along on every session check, so changing the scheme on
    // the website reaches a front desk on its next Refresh rather than needing
    // the app restarted.
    return res.json({
      success: true,
      user: sessionPayload(req.desktopUser),
      theme: await currentPalette(),
      // Moves forward while the desk is in use (see desktopAuth's sliding
      // renewal), so a desk that saved the login's expiry can refresh it.
      expires_at: new Date(req.desktopToken.expiresAt).toISOString()
    });
  },

  // POST /api/desktop/unlock   { password }
  //
  // The web kiosk's "Staff" button: the signed-in desk account's password,
  // typed again, buys a few minutes of the staff-only actions -- the people
  // search and checking someone in by hand (see kioskStaffOnly). Wrong
  // guesses count toward the same throttle as sign-in, since it is the same
  // password being guessed.
  unlock: async (req, res) => {
    const password = String((req.body && req.body.password) || '');

    // Every attempt goes in the audit trail, granted or not: a run of wrong
    // passwords at a kiosk is somebody at the public side of the counter
    // trying to get at the member list.
    const audit = (success, message) =>
      AttendanceLog.record({
        event: success ? 'staff_unlock' : 'staff_unlock_denied',
        userId: req.desktopUser._id,
        userName: sessionPayload(req.desktopUser).name,
        userEmail: req.desktopUser.email,
        success,
        message,
        device: req.deviceContext.deviceLabel,
        osUser: req.deviceContext.osUser,
        clientApp: req.deviceContext.clientApp,
        ip: req.deviceContext.ip
      });

    try {
      if (!password) {
        return res.status(400).json({ success: false, message: 'Enter the password for this desk account.' });
      }

      const key = attemptKey(req.desktopUser, null, req.deviceContext.ip);
      if (isThrottled(key)) {
        audit(false, 'Throttled after too many wrong passwords');
        return res.status(429).json({
          success: false,
          message: 'Too many wrong passwords. Wait a few minutes and try again.'
        });
      }

      // desktopAuth loads the account without its password hash.
      const account = await User.findById(req.desktopUser._id).select('password');
      const matches = Boolean(account && account.password) && (await bcrypt.compare(password, account.password));
      if (!matches) {
        noteFailure(key);
        audit(false, 'Wrong password');
        // 400, not 401: the desk's session is fine, and a kiosk treats 401
        // as "sign in again".
        return res.status(400).json({
          success: false,
          code: 'WRONG_PASSWORD',
          message: 'That is not the password for this desk account.'
        });
      }

      clearFailures(key);

      const { unlock, expiresAt, ttlSeconds } = issueStaffUnlock(req.desktopToken._id);
      audit(true, '');
      return res.json({
        success: true,
        unlock,
        expires_at: expiresAt.toISOString(),
        // Relative as well, so a kiosk whose clock is off still counts the
        // grant down correctly.
        expires_in: ttlSeconds
      });
    } catch (err) {
      console.error('[attendance] unlock failed:', err);
      return res.status(500).json({ success: false, message: 'Could not unlock. Try again.' });
    }
  },

  // POST /api/desktop/logout
  logout: async (req, res) => {
    try {
      await DesktopToken.updateOne(
        { _id: req.desktopToken._id },
        { $set: { revokedAt: new Date() } }
      );

      AttendanceLog.record({
        event: 'logout',
        userId: req.desktopUser._id,
        userName: sessionPayload(req.desktopUser).name,
        userEmail: req.desktopUser.email,
        device: req.deviceContext.deviceLabel,
        ip: req.deviceContext.ip
      });

      return res.json({ success: true });
    } catch (err) {
      console.error('[attendance] logout failed:', err);
      return res.status(500).json({ success: false, message: 'Sign out failed.' });
    }
  },

  // POST /api/desktop/templates
  //
  // Hands every enrolled template, DECRYPTED, to the signed-in front-desk PC
  // so it can match scans locally. This is the one place templates leave the
  // server in the clear, which is why it is audit-logged on every call and
  // why the app's apiBaseUrl must be https in production.
  templates: async (req, res) => {
    try {
      const rows = await Fingerprint.find({ isActive: true })
        .select('+template personType personId fingerIndex')
        .lean();

      // A finger can outlive its owner. A deleted trainer or a deactivated
      // member must stop matching at the desk rather than keep checking in
      // as a ghost -- and their templates are not even decrypted. A finger
      // filed under a trainer profile that is also a staff account goes out
      // as that account's, the one /people lists, so the desk matches it to
      // the person it shows.
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

        const plain = Fingerprint.decryptTemplate(row.template);
        if (!plain) {
          // Encrypted under a secret this process no longer has. Skip it --
          // one unreadable finger must not break the whole desk.
          unreadable++;
          continue;
        }

        templates.push({
          person_type: row.personType,
          person_id: personId,
          finger_index: row.fingerIndex,
          template: plain
        });
      }

      AttendanceLog.record({
        event: 'template_download',
        userId: req.desktopUser._id,
        userName: sessionPayload(req.desktopUser).name,
        userEmail: req.desktopUser.email,
        device: req.deviceContext.deviceLabel,
        osUser: req.deviceContext.osUser,
        clientApp: req.deviceContext.clientApp,
        ip: req.deviceContext.ip,
        meta: { count: templates.length, unreadable, departed }
      });

      if (unreadable > 0) {
        console.warn(
          `[attendance] ${unreadable} fingerprint template(s) could not be decrypted -- ` +
            'FINGERPRINT_ENCRYPTION_KEY may have changed since they were enrolled.'
        );
      }

      // `unreadable` is said out loud rather than only logged: those people
      // have a finger on file that can never match, and the desk has to be
      // able to tell them to re-enrol.
      return res.json({ success: true, far: FAR_DENOMINATOR, templates, unreadable });
    } catch (err) {
      console.error('[attendance] templates failed:', err);
      return res.status(500).json({ success: false, message: 'Could not load the fingerprint list.' });
    }
  },

  // POST /api/desktop/people
  //
  // Serves two screens: the enrolment picker (who has no finger registered
  // yet) and the manual-lookup panel (find someone when the reader is
  // unavailable). `q` filters server-side so a desk searching by phone
  // number does not pull the whole directory first. A web kiosk only gets
  // here with a staff unlock (kioskStaffOnly in desktopRoutes): the list
  // carries phone numbers and emails.
  people: async (req, res) => {
    try {
      const q = String((req.body && req.body.q) || '').trim();
      const { members, staff } = await listPeople({ q });

      // Which of the listed people have at least one finger the desk can
      // actually match. The picker uses this to keep them out of the
      // enrolment list, and the lookup panel to show who can use the reader.
      // A template that no longer decrypts (the key changed since it was
      // enrolled) is left out of /templates, so counting it here would hide
      // its owner from the one screen they can be re-enrolled on.
      //
      // A trainer who is also on the staff is listed as the staff account,
      // and a finger filed under their trainer profile is theirs.
      const profiles = await trainerProfilesOf(staff.map((person) => person.id));
      const accountOf = new Map();
      for (const [userId, trainerIds] of profiles) {
        for (const trainerId of trainerIds) accountOf.set(String(trainerId), userId);
      }

      const listedIds = members.concat(staff).map((person) => person.id).concat(Array.from(accountOf.keys()));
      const enrolled = listedIds.length
        ? await Fingerprint.find({ isActive: true, personId: { $in: listedIds } })
            .select('+template personType personId')
            .lean()
        : [];

      const keyOf = (row) => {
        const id = String(row.personId);
        return row.personType === 'staff' && accountOf.has(id) ? `staff:${accountOf.get(id)}` : `${row.personType}:${id}`;
      };
      const enrolledKeys = Array.from(
        new Set(enrolled.filter((row) => Fingerprint.decryptTemplate(row.template) !== null).map(keyOf))
      );

      return res.json({
        success: true,
        members,
        staff,
        enrolled: enrolledKeys
      });
    } catch (err) {
      console.error('[attendance] people failed:', err);
      return res.status(500).json({ success: false, message: 'Could not load the people list.' });
    }
  },

  // POST /api/desktop/punch
  //
  // person_type + person_id -> one recorded punch and a full receipt. The
  // client has already decided WHO; this decides whether that was an in or an
  // out, and what to say about it.
  punch: async (req, res) => {
    const body = req.body || {};
    let personType = String(body.person_type || '').trim();
    let personId = String(body.person_id || '').trim();
    let method = String(body.method || 'fingerprint').trim();

    // A scanned QR code or a typed member/staff number stands in for the
    // person picker. Both come from the web kiosk; the fingerprint desk
    // keeps sending person_type/person_id.
    if (body.qr) {
      const resolved = verifyQrToken(String(body.qr));
      if (!resolved) {
        return res.status(400).json({
          success: false,
          message: 'That QR code is not valid or has expired. Open the account page for a fresh one.'
        });
      }
      personType = resolved.personType;
      personId = resolved.personId;
      method = 'qr';
    } else if (body.code) {
      const found = await findByCode(String(body.code));
      if (!found) {
        return res.status(404).json({ success: false, message: 'No member or staff member has that code.' });
      }
      personType = found.person_type;
      personId = found.id;
      method = 'code';
    }

    try {
      if (personType !== 'member' && personType !== 'staff') {
        return res.status(400).json({ success: false, message: 'Unknown person type.' });
      }
      if (!personId.match(/^[0-9a-fA-F]{24}$/)) {
        return res.status(400).json({ success: false, message: 'Unknown person.' });
      }

      const result = await recordPunch({
        personType,
        personId,
        operator: req.desktopUser,
        device: req.deviceContext,
        method
      });

      AttendanceLog.record({
        event: result.success ? 'punch' : 'punch_denied',
        userId: req.desktopUser._id,
        userName: sessionPayload(req.desktopUser).name,
        userEmail: req.desktopUser.email,
        personType,
        personId,
        personName: (result.person && result.person.name) || '',
        action: (result.detail && result.detail.action) || '',
        method,
        success: Boolean(result.success),
        message: result.message,
        device: req.deviceContext.deviceLabel,
        osUser: req.deviceContext.osUser,
        clientApp: req.deviceContext.clientApp,
        ip: req.deviceContext.ip,
        meta: result.detail ? { status: result.detail.status } : null
      });

      // A repeat scan and a real punch both carry a receipt, so the desk sees
      // the person either way; only `success` differs.
      return res.json({
        success: result.success,
        message: result.message,
        detail: result.detail || null
      });
    } catch (err) {
      console.error('[attendance] punch failed:', err);
      return res.status(500).json({ success: false, message: 'Could not record attendance.' });
    }
  },

  // POST /api/desktop/enroll
  //
  // Takes a FINISHED enrolment template -- the four scans were captured and
  // fused on the front-desk PC. Re-enrolling the same finger replaces it
  // rather than leaving two templates that both match.
  enroll: async (req, res) => {
    const body = req.body || {};
    const personType = String(body.person_type || '').trim();
    const personId = String(body.person_id || '').trim();
    const fingerIndex = parseInt(body.finger_index, 10);
    const template = String(body.template || '').trim();

    try {
      if (personType !== 'member' && personType !== 'staff') {
        return res.status(400).json({ success: false, message: 'Unknown person type.' });
      }
      if (!personId.match(/^[0-9a-fA-F]{24}$/)) {
        return res.status(400).json({ success: false, message: 'Unknown person.' });
      }
      if (!(fingerIndex >= 1 && fingerIndex <= 10)) {
        return res.status(400).json({ success: false, message: 'Pick which finger this is.' });
      }
      if (!template || !/^[A-Za-z0-9+/=]+$/.test(template)) {
        return res.status(400).json({ success: false, message: 'The scan did not produce a usable template.' });
      }

      const person = await resolvePerson(personType, personId);
      if (!person) {
        return res.status(404).json({ success: false, message: 'That person is no longer on file.' });
      }

      // A fingerprint template is biometric data. Nothing is stored until
      // the person has agreed: either earlier (their account page, or staff
      // recording a signed form) or right now, with the desk ticking the
      // consent box on their behalf.
      const record = person.record;
      const hasConsentField = record && typeof record === 'object' && 'consents' in (record.toObject ? record.toObject() : record);
      const consentGiven = !!(record && record.consents && record.consents.biometric && record.consents.biometric.given);
      const consentNow = body.consent === true || body.consent === 'true' || body.consent === 1;
      if (!consentGiven && !consentNow) {
        return res.status(409).json({
          success: false,
          code: 'CONSENT_REQUIRED',
          message: `${person.name} has not consented to fingerprint storage. Tick the consent box after they agree, or ask them to accept it in their account.`
        });
      }
      if (!consentGiven && consentNow && hasConsentField && record.save) {
        record.consents = record.consents || {};
        record.consents.biometric = { given: true, at: new Date(), source: 'desk', recordedBy: req.desktopUser._id, version: '2026-09' };
        await record.save();
      }

      const operatorName =
        [req.desktopUser.firstName, req.desktopUser.lastName].filter(Boolean).join(' ').trim() ||
        req.desktopUser.email;

      await Fingerprint.findOneAndUpdate(
        { personType, personId: person.id, fingerIndex },
        {
          $set: {
            template: Fingerprint.encryptTemplate(template),
            samplesAccepted: parseInt(body.samples_accepted, 10) || 0,
            samplesTotal: parseInt(body.samples_total, 10) || 0,
            enrolledBy: req.desktopUser._id,
            enrolledByName: operatorName,
            enrolledDevice: req.deviceContext.deviceLabel,
            isActive: true
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // A trainer who is also on the staff enrols as the staff account, and
      // may have this finger on file under their trainer profile from before.
      // That is the template being replaced, so it goes too.
      if (person.aliasIds && person.aliasIds.length) {
        await Fingerprint.deleteMany({ personType, personId: { $in: person.aliasIds }, fingerIndex });
      }

      AttendanceLog.record({
        event: 'enroll',
        userId: req.desktopUser._id,
        userName: operatorName,
        userEmail: req.desktopUser.email,
        personType,
        personId: person.id,
        personName: person.name,
        success: true,
        device: req.deviceContext.deviceLabel,
        osUser: req.deviceContext.osUser,
        clientApp: req.deviceContext.clientApp,
        ip: req.deviceContext.ip,
        meta: { fingerIndex }
      });

      return res.json({
        success: true,
        message: `Fingerprint registered for ${person.name}.`,
        person: { person_type: person.personType, id: String(person.id), name: person.name, code: person.code }
      });
    } catch (err) {
      console.error('[attendance] enroll failed:', err);
      return res.status(500).json({ success: false, message: 'Could not save the fingerprint.' });
    }
  },

  // POST /api/desktop/recent   { limit }
  //
  // Today's punches, newest first -- so the desk can answer "is she already
  // in?" without opening the website. `counts` is the day's tally over ALL of
  // today's rows, not just the page returned, so the board's numbers do not
  // change with the page size:
  //
  //   total     visits today (rows)
  //   in_now    visits still open, and recent enough that a scan could close them
  //   lapsed    member visits on an expired, missing or suspended membership
  //   expiring  member visits whose membership ends within the warning window
  recent: async (req, res) => {
    try {
      const wanted = parseInt((req.body && req.body.limit) || 12, 10);
      const limit = Math.min(Math.max(1, Number.isFinite(wanted) ? wanted : 12), 200);
      const now = new Date();
      const today = T.dateKey(now);

      const [rows, tally] = await Promise.all([
        Attendance.find({ shiftDate: today })
          .sort({ updatedAt: -1 })
          .limit(limit)
          .lean(),
        Attendance.aggregate([
          { $match: { shiftDate: today } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              in_now: { $sum: { $cond: [openVisitExpr(now), 1, 0] } },
              lapsed: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$personType', 'member'] },
                        { $in: [{ $ifNull: ['$membership.status', 'none'] }, ['expired', 'none', 'suspended']] }
                      ]
                    },
                    1,
                    0
                  ]
                }
              },
              expiring: { $sum: { $cond: [{ $eq: ['$status', 'membership_expiring'] }, 1, 0] } }
            }
          }
        ])
      ]);

      const counts = tally[0] || {};

      return res.json({
        success: true,
        date_label: T.dateLabelForKey(today),
        counts: {
          total: counts.total || 0,
          in_now: counts.in_now || 0,
          lapsed: counts.lapsed || 0,
          expiring: counts.expiring || 0
        },
        entries: rows.map((row) => {
          // Worded as the receipt was: how a staff shift ended once it has.
          const verdict = currentVerdict(row);
          return {
            person_type: row.personType,
            name: row.personName,
            code: row.personCode,
            check_in_time: T.timeLabel(row.checkInAt),
            check_out_time: T.timeLabel(row.checkOutAt),
            still_in: isOpenVisit(row, now),
            no_check_out: missedCheckOut(row, now),
            status: verdict.status,
            status_label: verdict.label,
            // When the membership they walked in on runs (or ran) out, for
            // the board's "Valid to". Null for staff, and for a member with
            // no dated package.
            end_date_label:
              row.personType === 'member' && row.membership && row.membership.endDate
                ? T.dateLabel(row.membership.endDate)
                : null
          };
        })
      });
    } catch (err) {
      console.error('[attendance] recent failed:', err);
      return res.status(500).json({ success: false, message: 'Could not load recent activity.' });
    }
  }
};
