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
// "forgot password" when they first sign in.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/user');
const Package = require('../gymfolio/models/packageModel');
const { createManualOrder } = require('../gymfolio/services/membershipService');
const { checkLimit } = require('../platform/planLimits');
const T = require('../attendance/services/timeUtils');

const MAX_ROWS = 5000;

const COLUMNS = {
  firstName: ['firstname', 'first', 'givenname', 'forename'],
  lastName: ['lastname', 'last', 'surname', 'familyname'],
  email: ['email', 'emailaddress', 'mail'],
  phone: ['phone', 'mobile', 'phonenumber', 'mobilenumber', 'tel', 'telephone', 'cell'],
  dateOfBirth: ['dob', 'dateofbirth', 'birthdate', 'birthday'],
  gender: ['gender', 'sex'],
  memberCode: ['membercode', 'code', 'memberid', 'memberno', 'membernumber', 'id'],
  package: ['package', 'membership', 'plan', 'packagename'],
  startDate: ['startdate', 'start', 'joined', 'joindate', 'membershipstart', 'from'],
  endDate: ['enddate', 'end', 'expiry', 'expires', 'expirydate', 'membershipend', 'until', 'validto'],
  paid: ['paid', 'ispaid', 'paymentstatus'],
  amount: ['amount', 'price', 'paidamount'],
  notes: ['notes', 'note', 'comments', 'remarks']
};

const TEMPLATE_HEADER = 'firstName,lastName,email,phone,dateOfBirth,gender,memberCode,package,startDate,endDate,paid,amount,notes';
const TEMPLATE_EXAMPLE = 'Jane,Doe,jane@example.com,+447700900000,1990-05-14,female,GP-0101,Monthly,2026-09-01,2026-10-01,yes,40,Came from the old system';

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
      if (columns.email === undefined) {
        return res.status(400).json({ success: false, message: 'The file needs an "email" column' });
      }

      const packages = await Package.find({}).lean();
      const packageByName = new Map(packages.map((p) => [String(p.name).trim().toLowerCase(), p]));

      const report = { total: rows.length - 1, created: 0, memberships: 0, skipped: [], errors: [], dryRun: !!dryRun };
      const cell = (row, field) => (columns[field] === undefined ? '' : String(row[columns[field]] || '').trim());
      const seenEmails = new Set();

      for (let i = 1; i < rows.length; i += 1) {
        const row = rows[i];
        const line = i + 1;
        const email = cell(row, 'email').toLowerCase();
        try {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            report.skipped.push({ line, email, reason: 'Invalid or missing email' });
            continue;
          }
          if (seenEmails.has(email)) {
            report.skipped.push({ line, email, reason: 'Duplicate email in the file' });
            continue;
          }
          seenEmails.add(email);

          if (await User.exists({ email })) {
            report.skipped.push({ line, email, reason: 'An account with this email already exists' });
            continue;
          }

          const packageName = cell(row, 'package');
          const pkg = packageName ? packageByName.get(packageName.toLowerCase()) : null;
          if (packageName && !pkg) {
            report.errors.push({ line, email, reason: `No package called "${packageName}" — the member is created without a membership` });
          }

          const limit = await checkLimit('members');
          if (!limit.ok) {
            report.skipped.push({ line, email, reason: limit.message });
            continue;
          }

          if (dryRun) {
            report.created += 1;
            if (pkg) report.memberships += 1;
            continue;
          }

          const memberCode = cell(row, 'memberCode');
          const codeTaken = memberCode ? await User.exists({ memberCode }) : false;
          if (memberCode && codeTaken) {
            report.errors.push({ line, email, reason: `Member code ${memberCode} is already in use — a new one will be assigned` });
          }

          const dob = parseDate(cell(row, 'dateOfBirth'));
          const hashed = await bcrypt.hash(randomPassword(), await bcrypt.genSalt(10));
          const user = await User.create({
            firstName: cell(row, 'firstName') || email.split('@')[0],
            lastName: cell(row, 'lastName') || '',
            email,
            password: hashed,
            role: 'user',
            phone: cell(row, 'phone') || null,
            dateOfBirth: dob,
            gender: cell(row, 'gender') || null,
            memberCode: memberCode && !codeTaken ? memberCode : null,
            isActive: true
          });
          report.created += 1;

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
              notes: cell(row, 'notes') || `Imported from CSV by ${req.user && req.user.email}`,
              by: req.user && req.user.email
            });
            report.memberships += 1;
          }
        } catch (error) {
          report.errors.push({ line, email, reason: error.message });
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
