// src/controller/userImportController.js
//
// Bringing a gym's existing members in from a spreadsheet. Every gym that
// switches to GymPilot already has its members somewhere else; without this
// they retype hundreds of people by hand, and most would not.
//
// One CSV, one row per member. Columns are matched by name, loosely
// ("First Name", "firstname" and "first_name" all work), and a package
// column creates a paid membership with the dates given. Nothing is emailed
// to the members: they are told by the gym, and set a password through
// "forgot password" when they first sign in -- or, with no email address
// (which is allowed: a row needs an email OR a phone number), staff set one
// for them from Users -> Set password and they sign in with their username.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/user');
const Package = require('../gymfolio/models/packageModel');
const { createManualOrder } = require('../gymfolio/services/membershipService');
const { checkLimit } = require('../platform/planLimits');
const { assignMemberCode } = require('../attendance/services/peopleDirectory');
const { oneLine } = require('../services/memberFields');
const T = require('../attendance/services/timeUtils');

const MAX_ROWS = 5000;

const COLUMNS = {
  firstName: ['firstname', 'first', 'givenname', 'forename'],
  lastName: ['lastname', 'last', 'surname', 'familyname'],
  // One column holding the whole name, as many old systems export it. Used
  // when there are no separate first / last name cells: the first word is
  // the first name, the rest the last name.
  fullName: ['fullname', 'name', 'membername', 'customername'],
  email: ['email', 'emailaddress', 'mail'],
  phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'tel', 'telephone', 'cell'],
  dateOfBirth: ['dob', 'dateofbirth', 'birthdate', 'birthday'],
  gender: ['gender', 'sex'],
  address: ['address', 'streetaddress', 'homeaddress', 'address1', 'addressline1'],
  memberCode: ['membercode', 'code', 'memberid', 'memberno', 'membernumber', 'id'],
  // When the member first joined the gym, which becomes their "joined"
  // date. Imports only: a member added by staff joined today.
  joinedAt: ['joiningdate', 'registrationdate', 'registereddate', 'dateregistered', 'datejoined', 'membersince', 'signupdate'],
  active: ['active', 'isactive', 'status', 'accountstatus', 'memberstatus'],
  package: ['package', 'membership', 'plan', 'packagename'],
  startDate: ['startdate', 'start', 'joined', 'joindate', 'membershipstart', 'from'],
  endDate: ['enddate', 'end', 'expiry', 'expires', 'expirydate', 'membershipend', 'until', 'validto'],
  paid: ['paid', 'ispaid', 'paymentstatus'],
  amount: ['amount', 'price', 'paidamount'],
  discount: ['discount', 'discountamount'],
  notes: ['notes', 'note', 'comments', 'remarks']
};

const TEMPLATE_HEADER = 'firstName,lastName,email,phone,dateOfBirth,gender,address,memberCode,joiningDate,active,package,startDate,endDate,paid,amount,discount,notes';
const TEMPLATE_EXAMPLE = [
  'Jane,Doe,jane@example.com,+447700900000,1990-05-14,female,"12 High Street, Leeds",GP-0101,2024-03-02,yes,Monthly,2026-09-01,2026-10-01,yes,40,,Came from the old system',
  // No email: the phone number is enough. Staff give them a password later.
  'Ali,Khan,,+923001234567,,male,,,2025-01-15,yes,Monthly,2026-09-01,2026-10-01,yes,,5,Pays at the desk'
].join('\n');

/** RFC 4180-ish CSV parser: quotes, escaped quotes, CRLF, BOM. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text || '').replace(/^﻿/, '');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

function normaliseHeader(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((raw, index) => {
    const key = normaliseHeader(raw);
    for (const [field, aliases] of Object.entries(COLUMNS)) {
      if (map[field] === undefined && (key === field.toLowerCase() || aliases.includes(key))) {
        map[field] = index;
      }
    }
  });
  return map;
}

// A calendar date as 'YYYY-MM-DD', or null when there is no such day.
function dateKeyOf(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A date from a spreadsheet cell. A bare date names a whole day at the GYM,
 * not midnight UTC -- read as UTC, a membership ending 30 Sep stopped working
 * at 5am that morning in Karachi. `at` says which moment of the day is meant:
 * 'start' (a membership starting), 'end' (the last moment of a membership
 * ending that day) or 'noon' (a birthday, safely inside the day).
 */
function parseDate(value, at = 'noon') {
  const text = String(value || '').trim();
  if (!text) return null;

  // ISO first (a spreadsheet's "2026-09-30 00:00:00" is a date too); then
  // dd/mm/yyyy and dd-mm-yyyy, which spreadsheets love.
  let key = null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]00:00(?::00(?:\.0+)?)?Z?)?$/);
  const local = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (iso) key = dateKeyOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  else if (local) key = dateKeyOf(Number(local[3]), Number(local[2]), Number(local[1]));
  else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(text)) {
    // A timestamp with a real time of day names its own instant.
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (!key) return null;

  if (at === 'start') return T.startOfLocalDay(key);
  if (at === 'end') return T.lastMomentOfLocalDay(key);
  return T.localInstant(key, 12, 0);
}

function truthy(value, fallback = true) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  return !['no', 'n', 'false', '0', 'unpaid', 'pending'].includes(text);
}

const ACTIVE_WORDS = ['yes', 'y', 'true', '1', 'active', 'enabled', 'current'];
const INACTIVE_WORDS = ['no', 'n', 'false', '0', 'inactive', 'disabled', 'suspended', 'cancelled', 'canceled'];

/**
 * An `active` cell: true / false, or null when it says something else. A
 * blank cell is an active member, as every member used to be imported.
 */
function parseActive(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return true;
  if (ACTIVE_WORDS.includes(text)) return true;
  if (INACTIVE_WORDS.includes(text)) return false;
  return null;
}

/** "Ayesha Khan Malik" -> first "Ayesha", last "Khan Malik". */
function splitFullName(value) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: words[0] || '', lastName: words.slice(1).join(' ') };
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function randomPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

module.exports = {
  // GET /admin/users/import/template
  template: (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gympilot-members-template.csv"');
    return res.send(`${TEMPLATE_HEADER}\n${TEMPLATE_EXAMPLE}\n`);
  },

  // POST /admin/users/import   multipart: file (csv), dryRun ('1' to only report)
  importCsv: async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ success: false, message: 'Attach a CSV file' });
      }
      const dryRun = req.body && (req.body.dryRun === '1' || req.body.dryRun === 'true');

      const rows = parseCsv(req.file.buffer.toString('utf8'));
      if (rows.length < 2) return res.status(400).json({ success: false, message: 'The file has no data rows' });
      if (rows.length - 1 > MAX_ROWS) {
        return res.status(400).json({ success: false, message: `Import at most ${MAX_ROWS} members at a time` });
      }

      const columns = mapHeaders(rows[0]);
      if (columns.email === undefined && columns.phone === undefined) {
        return res.status(400).json({ success: false, message: 'The file needs an "email" or a "phone" column' });
      }
      const hasName = columns.fullName !== undefined || columns.firstName !== undefined || columns.email !== undefined;
      if (!hasName) {
        return res.status(400).json({ success: false, message: 'The file needs a "name" column, or "firstName" and "lastName"' });
      }

      const packages = await Package.find({}).lean();
      const packageByName = new Map(packages.map((p) => [String(p.name).trim().toLowerCase(), p]));

      const report = {
        total: rows.length - 1,
        created: 0,
        memberships: 0,
        withoutEmail: 0,
        inactive: 0,
        // Which of the recognised columns this file has, so the preview can
        // say what will be read before anything is written.
        columns: Object.keys(columns),
        skipped: [],
        errors: [],
        dryRun: !!dryRun
      };
      const cell = (row, field) => (columns[field] === undefined ? '' : String(row[columns[field]] || '').trim());
      const seenEmails = new Set();
      const seenPhoneNames = new Set();

      for (let i = 1; i < rows.length; i += 1) {
        const row = rows[i];
        const line = i + 1;
        const email = cell(row, 'email').toLowerCase();
        const phone = cell(row, 'phone');
        // The separate name cells win; a single full-name cell fills in
        // whatever they leave empty.
        const whole = splitFullName(cell(row, 'fullName'));
        const firstName = cell(row, 'firstName') || whole.firstName || (email ? email.split('@')[0] : '');
        const lastName = cell(row, 'lastName') || whole.lastName;
        const name = [firstName, lastName].filter(Boolean).join(' ');
        try {
          if (!email && !phone) {
            report.skipped.push({ line, email, name, reason: 'Needs an email or a phone number' });
            continue;
          }
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            report.skipped.push({ line, email, name, reason: 'Invalid email' });
            continue;
          }
          if (!firstName || !lastName) {
            report.skipped.push({ line, email, name, reason: 'Needs a first and a last name' });
            continue;
          }

          if (email) {
            if (seenEmails.has(email)) {
              report.skipped.push({ line, email, name, reason: 'Duplicate email in the file' });
              continue;
            }
            seenEmails.add(email);

            if (await User.exists({ email })) {
              report.skipped.push({ line, email, name, reason: 'An account with this email already exists' });
              continue;
            }
          } else {
            // Without an email, the same name on the same phone number is
            // the same person: a second run of the same file must not make
            // everybody twice. (A family sharing one phone has different
            // names, so they still come in.)
            const key = `${phone}|${name.toLowerCase()}`;
            if (seenPhoneNames.has(key)) {
              report.skipped.push({ line, email, name, reason: 'Duplicate name and phone in the file' });
              continue;
            }
            seenPhoneNames.add(key);

            const same = await User.exists({
              phone,
              firstName: new RegExp(`^${escapeRegex(firstName)}$`, 'i'),
              lastName: new RegExp(`^${escapeRegex(lastName)}$`, 'i')
            });
            if (same) {
              report.skipped.push({ line, email, name, reason: 'A member with this name and phone number already exists' });
              continue;
            }
          }

          let active = parseActive(cell(row, 'active'));
          if (active === null) {
            report.errors.push({ line, email, name, reason: `Could not read "${cell(row, 'active')}" as active or inactive — imported as active` });
            active = true;
          }

          const joinedCell = cell(row, 'joinedAt');
          const joinedAt = joinedCell ? parseDate(joinedCell, 'start') : null;
          if (joinedCell && !joinedAt) {
            report.errors.push({ line, email, name, reason: `Could not read the joining date "${joinedCell}" — today is used` });
          }

          const discountCell = cell(row, 'discount');
          const discount = discountCell ? Number(discountCell.replace(/[^0-9.\-]/g, '')) : 0;
          if (discountCell && !(Number.isFinite(discount) && discount >= 0)) {
            report.errors.push({ line, email, name, reason: `Could not read the discount "${discountCell}" — none applied` });
          }

          const packageName = cell(row, 'package');
          const pkg = packageName ? packageByName.get(packageName.toLowerCase()) : null;
          if (packageName && !pkg) {
            report.errors.push({ line, email, name, reason: `No package called "${packageName}" — the member is created without a membership` });
          }

          const limit = await checkLimit('members');
          if (!limit.ok) {
            report.skipped.push({ line, email, name, reason: limit.message });
            continue;
          }

          if (dryRun) {
            report.created += 1;
            if (!email) report.withoutEmail += 1;
            if (!active) report.inactive += 1;
            if (pkg) report.memberships += 1;
            continue;
          }

          const memberCode = cell(row, 'memberCode');
          const codeTaken = memberCode ? await User.exists({ memberCode }) : false;
          if (memberCode && codeTaken) {
            report.errors.push({ line, email, name, reason: `Member code ${memberCode} is already in use — a new one will be assigned` });
          }

          const dob = parseDate(cell(row, 'dateOfBirth'));
          // A quoted cell can hold line breaks; the desk's address is one line.
          const address = oneLine(cell(row, 'address')).slice(0, 300);
          const hashed = await bcrypt.hash(randomPassword(), await bcrypt.genSalt(10));
          const user = await User.create({
            firstName,
            lastName,
            email: email || undefined,
            password: hashed,
            role: 'user',
            phone: phone || null,
            dateOfBirth: dob,
            gender: cell(row, 'gender') || null,
            // One line, as the desk types it, in the account's primary
            // address -- the shape the member's own address book uses.
            addresses: address ? [{ label: 'primary', isDefault: true, address }] : [],
            memberCode: memberCode && !codeTaken ? memberCode : null,
            isActive: active,
            // Their real joining date from the old system, so this month's
            // "new members" is not everybody who was ever imported.
            ...(joinedAt ? { createdAt: joinedAt } : {})
          });
          // The old system's ID when it had one that is free; otherwise the
          // next in the gym's own series, as any new member gets.
          if (!user.memberCode) await assignMemberCode(user);
          report.created += 1;
          if (!email) report.withoutEmail += 1;
          if (!active) report.inactive += 1;

          if (pkg) {
            // Access from the start of the first day to the end of the last.
            const start = parseDate(cell(row, 'startDate'), 'start');
            const end = parseDate(cell(row, 'endDate'), 'end');
            const amount = cell(row, 'amount');
            await createManualOrder({
              user,
              pkg,
              paymentMethod: 'cash',
              markPaid: truthy(cell(row, 'paid'), true),
              startDate: start || undefined,
              endDate: end || undefined,
              amountOverride: amount || undefined,
              discountAmount: Number.isFinite(discount) && discount > 0 ? discount : 0,
              discountNote: Number.isFinite(discount) && discount > 0 ? 'Imported from CSV' : '',
              notes: cell(row, 'notes') || `Imported from CSV by ${req.user && req.user.email}`,
              by: req.user && req.user.email
            });
            report.memberships += 1;
          }
        } catch (error) {
          report.errors.push({ line, email, name, reason: error.message });
        }
      }

      return res.json({
        success: true,
        message: dryRun
          ? `${report.created} member(s) would be created, ${report.skipped.length} skipped.`
          : `${report.created} member(s) imported, ${report.memberships} membership(s) created, ${report.skipped.length} skipped.`,
        data: report
      });
    } catch (error) {
      console.error('[import] failed:', error);
      return res.status(500).json({ success: false, message: error.message || 'Import failed' });
    }
  }
};

module.exports.parseCsv = parseCsv;
module.exports.mapHeaders = mapHeaders;
module.exports.parseDate = parseDate;
module.exports.parseActive = parseActive;
module.exports.splitFullName = splitFullName;
