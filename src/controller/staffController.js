// src/controller/staffController.js
//
// Registering and managing the people who WORK here, as opposed to the people
// who train here. Both are User documents; the role slug is what separates
// them, and `employment.isStaff` is the denormalised answer so "list the staff"
// is one indexed query rather than a join against the roles collection.
//
// A staff member is created the same way an admin-created member is: the
// password is generated server-side and emailed. A plaintext password is never
// accepted over the wire, so an admin filling in this form cannot choose one
// (and cannot learn one they should not know).

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');

const User = require('../models/user');
const Role = require('../models/roleModel');
const Attendance = require('../attendance/models/attendanceModel');
const Trainer = require('../gymfolio/models/trainerModel');
const { sendEmail } = require('../services/emailService');
const { ADMIN_SLUG, MEMBER_SLUG, ensureDefaultRoles, invalidate } = require('../services/roleService');
const T = require('../attendance/services/timeUtils');
const { frontendOrigin: tenantOrigin } = require('../platform/tenantContext');
const { checkLimit } = require('../platform/planLimits');

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern', 'casual'];
const PAY_CYCLES = ['monthly', 'biweekly', 'weekly'];
const STAFF_PREFIX = 'TR-';

// Same generator as admin user creation: readable enough to retype from an
// email, without the glyphs that get misread doing it.
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

function staffWelcomeEmail({ firstName, email, password, roleName, siteName, loginUrl }) {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
    <h2 style="margin:0 0 8px">Welcome to ${siteName}, ${firstName}</h2>
    <p style="margin:0 0 16px;color:#4b5563">
      An account has been created for you as <strong>${roleName}</strong>.
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:0 0 16px">
      <p style="margin:0 0 6px"><strong>Email:</strong> ${email}</p>
      <p style="margin:0"><strong>Temporary password:</strong> ${password}</p>
    </div>
    <p style="margin:0 0 16px;color:#4b5563">
      Please sign in and change this password. Your fingerprint can be enrolled at the front desk
      so you can clock in and out on the reader.
    </p>
    <a href="${loginUrl}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">Sign in</a>
  </div>`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// A shift with no times is not a shift; a start after an end is an overnight
// one, which the attendance verdicts already understand, so it is allowed.
function cleanSchedule(input) {
  if (!Array.isArray(input)) return [];

  const seen = new Set();
  const rows = [];

  for (const entry of input) {
    if (!entry || !WEEKDAYS.includes(entry.day)) continue;
    if (seen.has(entry.day)) continue;

    const start = String(entry.startTime || '').trim();
    const end = String(entry.endTime || '').trim();
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) continue;

    seen.add(entry.day);
    rows.push({ day: entry.day, startTime: start, endTime: end });
  }

  // Kept in weekday order so the roster reads like a week, not like the order
  // the form happened to submit.
  return rows.sort((a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day));
}

function cleanPayroll(input = {}) {
  const basis = input.basis === 'hourly' ? 'hourly' : 'salaried';
  return {
    basis,
    salary: Math.max(0, Number(input.salary) || 0),
    hourlyRate: Math.max(0, Number(input.hourlyRate) || 0),
    currency: String(input.currency || 'PKR').trim().toUpperCase().slice(0, 8),
    cycle: PAY_CYCLES.includes(input.cycle) ? input.cycle : 'monthly',
    contractHoursPerWeek: Math.max(0, Number(input.contractHoursPerWeek) || 0),
    bankName: String(input.bankName || '').trim(),
    accountTitle: String(input.accountTitle || '').trim(),
    accountNumber: String(input.accountNumber || '').trim(),
    notes: String(input.notes || '').trim()
  };
}

function cleanEmployment(input = {}, existing = {}) {
  return {
    isStaff: true,
    jobTitle: String(input.jobTitle ?? existing.jobTitle ?? '').trim(),
    department: String(input.department ?? existing.department ?? '').trim(),
    employmentType: EMPLOYMENT_TYPES.includes(input.employmentType)
      ? input.employmentType
      : existing.employmentType || 'full_time',
    joinedAt: input.joinedAt ? new Date(input.joinedAt) : existing.joinedAt || new Date(),
    endedAt: input.endedAt ? new Date(input.endedAt) : existing.endedAt || null,
    payroll: cleanPayroll(input.payroll || existing.payroll || {}),
    schedule: input.schedule !== undefined ? cleanSchedule(input.schedule) : existing.schedule || [],
    emergencyContact: {
      name: String((input.emergencyContact || {}).name ?? (existing.emergencyContact || {}).name ?? '').trim(),
      phone: String((input.emergencyContact || {}).phone ?? (existing.emergencyContact || {}).phone ?? '').trim(),
      relationship: String(
        (input.emergencyContact || {}).relationship ?? (existing.emergencyContact || {}).relationship ?? ''
      ).trim()
    }
  };
}

// Sequential, short enough to read across a desk. Same scheme trainers use, in
// the same series, so the two never collide at the front desk.
async function nextStaffCode() {
  const [lastUser, lastTrainer] = await Promise.all([
    User.findOne({ staffCode: new RegExp('^' + STAFF_PREFIX) }).sort({ staffCode: -1 }).select('staffCode').lean(),
    Trainer.findOne({ staffCode: new RegExp('^' + STAFF_PREFIX) })
      .sort({ staffCode: -1 })
      .select('staffCode')
      .lean()
  ]);

  const parse = (row) => {
    if (!row || !row.staffCode) return 0;
    const value = parseInt(String(row.staffCode).slice(STAFF_PREFIX.length), 10);
    return Number.isNaN(value) ? 0 : value;
  };

  return STAFF_PREFIX + String(Math.max(parse(lastUser), parse(lastTrainer)) + 1).padStart(4, '0');
}

function scheduleSummary(schedule) {
  if (!schedule || !schedule.length) return { days: 0, label: 'No roster set', weekly_hours: 0 };

  let minutes = 0;
  for (const shift of schedule) {
    const start = T.parseClock(shift.startTime);
    const end = T.parseClock(shift.endTime);
    if (start === null || end === null) continue;
    // An end before a start is an overnight shift, not a negative one.
    minutes += end >= start ? end - start : end + 1440 - start;
  }

  return {
    days: schedule.length,
    label: `${schedule.length} day${schedule.length === 1 ? '' : 's'} · ${Math.round((minutes / 60) * 10) / 10} h/week`,
    weekly_hours: Math.round((minutes / 60) * 10) / 10
  };
}

function shapeStaff(user, roleName, stats) {
  const employment = user.employment || {};
  const payroll = employment.payroll || {};

  return {
    id: String(user._id),
    name: [user.firstName, user.lastName].filter(Boolean).join(' ').trim(),
    first_name: user.firstName,
    last_name: user.lastName,
    email: user.email,
    phone: user.phone || '',
    staff_code: user.staffCode || '',
    role: user.role,
    role_name: roleName || user.role,
    is_active: user.isActive !== false,

    job_title: employment.jobTitle || '',
    department: employment.department || '',
    employment_type: employment.employmentType || 'full_time',
    joined_at: employment.joinedAt || null,
    joined_label: employment.joinedAt ? T.dateLabel(employment.joinedAt) : null,
    ended_at: employment.endedAt || null,

    payroll: {
      basis: payroll.basis || 'salaried',
      salary: payroll.salary || 0,
      hourly_rate: payroll.hourlyRate || 0,
      currency: payroll.currency || 'PKR',
      cycle: payroll.cycle || 'monthly',
      contract_hours_per_week: payroll.contractHoursPerWeek || 0,
      bank_name: payroll.bankName || '',
      account_title: payroll.accountTitle || '',
      account_number: payroll.accountNumber || '',
      notes: payroll.notes || ''
    },

    schedule: (employment.schedule || []).map((shift) => ({
      day: shift.day,
      start_time: shift.startTime,
      end_time: shift.endTime
    })),
    schedule_summary: scheduleSummary(employment.schedule),

    emergency_contact: employment.emergencyContact || { name: '', phone: '', relationship: '' },

    attendance: stats || { visits: 0, minutes: 0, label: '0 m', last_seen_label: null, still_in: false },

    // Front-desk grants live on the account, and this is the screen that
    // manages the account, so they are editable from here rather than from a
    // separate permissions page nobody would think to open.
    allow_attendance_app: !!user.allowAttendanceApp,
    allow_fingerprint_enrollment: !!user.allowFingerprintEnrollment,
    attendance_location: user.attendanceLocation || ''
  };
}

module.exports = {
  // GET /api/staff
  list: async (req, res) => {
    try {
      await ensureDefaultRoles();

      const filter = { 'employment.isStaff': true };

      if (req.query.role && req.query.role !== 'all') filter.role = String(req.query.role);
      if (req.query.status === 'active') filter.isActive = true;
      if (req.query.status === 'inactive') filter.isActive = false;
      if (req.query.department && req.query.department !== 'all') {
        filter['employment.department'] = String(req.query.department);
      }

      const term = String(req.query.q || '').trim();
      if (term) {
        const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [
          { firstName: rx },
          { lastName: rx },
          { email: rx },
          { phone: rx },
          { staffCode: rx },
          { 'employment.jobTitle': rx }
        ];
      }

      const staff = await User.find(filter).select('-password').sort({ firstName: 1, lastName: 1 }).lean();

      const roles = await Role.find().select('slug name').lean();
      const roleNames = new Map(roles.map((role) => [role.slug, role.name]));

      // This month's hours per person, in one pass -- the number a payroll
      // conversation actually starts from.
      const monthPrefix = T.dateKey().slice(0, 7);
      const rollups = staff.length
        ? await Attendance.aggregate([
            {
              $match: {
                personType: 'staff',
                personId: { $in: staff.map((row) => row._id) },
                shiftDate: new RegExp('^' + monthPrefix)
              }
            },
            { $sort: { checkInAt: 1 } },
            {
              $group: {
                _id: '$personId',
                visits: { $sum: 1 },
                minutes: { $sum: { $ifNull: ['$workedMinutes', 0] } },
                open: { $sum: { $cond: [{ $eq: ['$checkOutAt', null] }, 1, 0] } },
                lastCheckIn: { $last: '$checkInAt' },
                lastShiftDate: { $last: '$shiftDate' }
              }
            }
          ])
        : [];

      const statsById = new Map(
        rollups.map((entry) => [
          String(entry._id),
          {
            visits: entry.visits,
            minutes: entry.minutes,
            label: T.durationLabel(entry.minutes) || '0 m',
            last_seen_label: entry.lastCheckIn
              ? `${T.dateLabelForKey(entry.lastShiftDate)} · ${T.timeLabel(entry.lastCheckIn)}`
              : null,
            still_in: entry.open > 0
          }
        ])
      );

      const departments = [
        ...new Set(staff.map((row) => (row.employment && row.employment.department) || '').filter(Boolean))
      ].sort();

      return res.json({
        success: true,
        month_label: T.dateLabelForKey(T.dateKey()).slice(3),
        departments,
        counts: {
          total: staff.length,
          active: staff.filter((row) => row.isActive !== false).length,
          on_shift: [...statsById.values()].filter((entry) => entry.still_in).length
        },
        staff: staff.map((row) => shapeStaff(row, roleNames.get(row.role), statsById.get(String(row._id))))
      });
    } catch (error) {
      console.error('[staff] list failed:', error);
      return res.status(500).json({ message: 'Could not load staff', error: error.message });
    }
  },

  // POST /api/staff
  create: async (req, res) => {
    try {
      await ensureDefaultRoles();

      const { firstName, lastName, email, phone, role } = req.body || {};

      if (!firstName || !lastName || !email) {
        return res.status(400).json({ message: 'First name, last name and email are required' });
      }

      const normalisedEmail = String(email).toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
        return res.status(400).json({ message: 'Please provide a valid email address' });
      }

      const roleDoc = await Role.findOne({ slug: String(role || '').toLowerCase().trim() });
      if (!roleDoc) return res.status(400).json({ message: 'Choose a role for this staff member' });
      if (!roleDoc.isStaff) {
        return res.status(400).json({
          message: `"${roleDoc.name}" is a member role, not a staff role. Pick a staff role or mark that role as staff.`
        });
      }

      const existing = await User.findOne({ email: normalisedEmail });
      if (existing) {
        return res.status(409).json({
          message: existing.employment && existing.employment.isStaff
            ? 'That email already belongs to a staff member'
            : 'That email already belongs to a member account. Promote it from the Users tab instead.'
        });
      }

      // The gym's platform plan may cap how many staff accounts it can hold.
      const limit = await checkLimit('staff');
      if (!limit.ok) return res.status(403).json({ message: limit.message, code: limit.code });

      const password = generatePassword();
      const hashed = await bcrypt.hash(password, await bcrypt.genSalt(10));

      const user = await User.create({
        firstName: String(firstName).trim(),
        lastName: String(lastName).trim(),
        email: normalisedEmail,
        phone: phone ? String(phone).trim() : null,
        password: hashed,
        role: roleDoc.slug,
        isActive: true,
        staffCode: await nextStaffCode(),
        employment: cleanEmployment(req.body.employment || req.body),
        allowAttendanceApp: !!req.body.allowAttendanceApp,
        allowFingerprintEnrollment: !!req.body.allowFingerprintEnrollment,
        attendanceLocation: String(req.body.attendanceLocation || '').trim()
      });

      // The account exists whether or not the email lands, so a send failure is
      // reported rather than rolled back -- the admin can read the address back
      // to them instead.
      let emailed = false;
      let emailError = null;
      try {
        const siteName = process.env.SITE_NAME || 'GymPilot';
        const loginUrl = `${tenantOrigin()}/authentication`;
        const result = await sendEmail(
          normalisedEmail,
          `Your ${siteName} staff account`,
          staffWelcomeEmail({
            firstName: user.firstName,
            email: normalisedEmail,
            password,
            roleName: roleDoc.name,
            siteName,
            loginUrl
          })
        );
        emailed = !!result.success;
        if (!result.success) emailError = result.error;
      } catch (err) {
        emailError = err.message;
      }

      invalidate();

      return res.status(201).json({
        success: true,
        message: emailed
          ? `${user.firstName} was registered and their sign-in details emailed.`
          : `${user.firstName} was registered, but the credentials email could not be sent.`,
        emailed,
        emailError,
        staff: shapeStaff(user.toObject(), roleDoc.name)
      });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'That email or staff code is already in use' });
      }
      console.error('[staff] create failed:', error);
      return res.status(400).json({ message: 'Could not register this staff member', error: error.message });
    }
  },

  // PUT /api/staff/:id
  update: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid staff id' });
      }

      const user = await User.findById(id);
      if (!user) return res.status(404).json({ message: 'Staff member not found' });

      const { firstName, lastName, phone, role } = req.body || {};

      if (firstName !== undefined) user.firstName = String(firstName).trim() || user.firstName;
      if (lastName !== undefined) user.lastName = String(lastName).trim() || user.lastName;
      if (phone !== undefined) user.phone = phone ? String(phone).trim() : null;

      let roleDoc = await Role.findOne({ slug: user.role });

      if (role !== undefined && role !== user.role) {
        const next = await Role.findOne({ slug: String(role).toLowerCase().trim() });
        if (!next) return res.status(400).json({ message: 'Unknown role' });

        // Demoting the last administrator would leave the panel unreachable.
        if (user.role === ADMIN_SLUG && next.slug !== ADMIN_SLUG) {
          const admins = await User.countDocuments({ role: ADMIN_SLUG, isActive: true });
          if (admins <= 1) {
            return res.status(400).json({ message: 'This is the last administrator. Promote someone else first.' });
          }
        }

        user.role = next.slug;
        roleDoc = next;

        // Moving someone onto a member role ends their employment rather than
        // leaving a payroll record attached to a customer.
        if (!next.isStaff) {
          user.employment.isStaff = false;
          user.employment.endedAt = user.employment.endedAt || new Date();
        }
      }

      if (roleDoc && roleDoc.isStaff) {
        user.employment = cleanEmployment(
          req.body.employment || req.body,
          (user.employment && user.employment.toObject ? user.employment.toObject() : user.employment) || {}
        );
        if (!user.staffCode) user.staffCode = await nextStaffCode();
      }

      if (req.body.allowAttendanceApp !== undefined) user.allowAttendanceApp = !!req.body.allowAttendanceApp;
      if (req.body.allowFingerprintEnrollment !== undefined) {
        user.allowFingerprintEnrollment = !!req.body.allowFingerprintEnrollment;
      }
      if (req.body.attendanceLocation !== undefined) {
        user.attendanceLocation = String(req.body.attendanceLocation).trim();
      }

      await user.save();
      invalidate();

      return res.json({
        success: true,
        message: 'Staff member updated',
        staff: shapeStaff(user.toObject(), roleDoc ? roleDoc.name : user.role)
      });
    } catch (error) {
      console.error('[staff] update failed:', error);
      return res.status(400).json({ message: 'Could not update this staff member', error: error.message });
    }
  },

  // PATCH /api/staff/:id/status
  setStatus: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid staff id' });
      }

      const isActive = !!req.body.isActive;
      const user = await User.findById(id);
      if (!user) return res.status(404).json({ message: 'Staff member not found' });

      if (!isActive && user.role === ADMIN_SLUG) {
        const admins = await User.countDocuments({ role: ADMIN_SLUG, isActive: true });
        if (admins <= 1) {
          return res.status(400).json({ message: 'This is the last active administrator.' });
        }
      }

      user.isActive = isActive;

      // Suspending someone must also close the front desk to them, or a
      // deactivated account keeps signing the attendance app in.
      if (!isActive) {
        user.allowAttendanceApp = false;
        user.allowFingerprintEnrollment = false;
        user.employment.endedAt = user.employment.endedAt || new Date();
      } else {
        user.employment.endedAt = null;
      }

      await user.save();

      return res.json({
        success: true,
        message: isActive ? 'Staff member reactivated' : 'Staff member deactivated'
      });
    } catch (error) {
      console.error('[staff] status failed:', error);
      return res.status(400).json({ message: 'Could not change that status', error: error.message });
    }
  },

  // DELETE /api/staff/:id
  //
  // Removes the employment, not the person: their punches, and the audit trail
  // that references them, must survive. The account drops back to being an
  // ordinary member.
  remove: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid staff id' });
      }

      const user = await User.findById(id);
      if (!user) return res.status(404).json({ message: 'Staff member not found' });

      if (user.role === ADMIN_SLUG) {
        const admins = await User.countDocuments({ role: ADMIN_SLUG, isActive: true });
        if (admins <= 1) {
          return res.status(400).json({ message: 'This is the last administrator.' });
        }
      }

      user.role = MEMBER_SLUG;
      user.employment.isStaff = false;
      user.employment.endedAt = new Date();
      user.allowAttendanceApp = false;
      user.allowFingerprintEnrollment = false;
      await user.save();
      invalidate();

      return res.json({
        success: true,
        message: `${user.firstName} is no longer staff. Their attendance history has been kept.`
      });
    } catch (error) {
      console.error('[staff] remove failed:', error);
      return res.status(400).json({ message: 'Could not remove this staff member', error: error.message });
    }
  }
};
