// src/controller/userImportController.js
//
// Bringing a gym's existing members in from a spreadsheet. Every gym that
// switches to GymsPilotPro already has its members somewhere else; without this
// they retype hundreds of people by hand, and most would not.
//
// One CSV, one row per member. Columns are matched by name, loosely
// ("First Name", "firstname" and "first_name" all work), and a package
// column creates a paid membership with the dates given. Nothing is emailed
// to the members: they are told by the gym, and set a password through
// "forgot password" when they first sign in -- or, with no email address
// (which is allowed: a row needs an email OR a phone number), staff set one
// for them from Users -> Set password and they sign in with their username.
//
// A big file takes more than one request. The import stops at its time
// budget and says how many rows are left; the same file uploaded again
// carries on, skipping whoever is already in and giving a membership to
// anyone an earlier upload created without theirs.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/user');
const Package = require('../gymfolio/models/packageModel');
const PackageOrder = require('../gymfolio/models/packageOrderModel');
const { createManualOrder } = require('../gymfolio/services/membershipService');
const { checkLimit, LIMIT_KINDS } = require('../platform/planLimits');
const { assignMemberCode } = require('../attendance/services/peopleDirectory');
const { oneLine } = require('../services/memberFields');
const T = require('../attendance/services/timeUtils');

const MAX_ROWS = 5000;

// How long an import goes on starting new rows. Each row is a password hash
// and a dozen round trips, so a big file cannot be done in one request: the
// API runs as serverless functions with a time limit, and a run killed by it
// answers nothing at all. IMPORT_BUDGET_MS must sit below the function's
// limit by a few seconds; the default suits a 60-second function, like
// DAILY_JOB_BUDGET_MS (platform/jobs.js).
const DEFAULT_BUDGET_MS = 40000;
function importBudgetMs(env = process.env) {
  const ms = parseInt(env.IMPORT_BUDGET_MS, 10);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_BUDGET_MS;
}

/** What staff are told when a run stops at its budget: what is left, and what to do. */
function stoppedNote(report) {
  if (report.dryRun) {
    return `The preview stopped before the time limit: ${report.remaining} row(s) were not checked. Importing takes them in turn — upload the file again each time it stops.`;
  }
  return `Stopped before the time limit with ${report.remaining} row(s) still to do. Upload the same file again to carry on — members already imported are skipped, so nobody is added twice.`;
}

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

  // A timestamp that names its own zone is an instant -- except midnight
  // UTC, which is how a plain date comes out of many exports.
  if (ZONED_TIMESTAMP.test(text) && !/[T ]00:00(?::00(?:\.0+)?)?Z$/i.test(text)) {
    const d = new Date(text.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const key = dateKeyFrom(text);
  if (!key) return null;

  if (at === 'start') return T.startOfLocalDay(key);
  if (at === 'end') return T.lastMomentOfLocalDay(key);
  return T.localInstant(key, 12, 0);
}

const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Between the parts of a date written with the month's name: "30 Sep 2026",
// "30-Sep-2026", "Sep 30, 2026".
const GAP = '[\\s,./-]+';
const DAY_THEN_MONTH = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?${GAP}([a-z]{3,9})${GAP}(\\d{4})$`, 'i');
const MONTH_THEN_DAY = new RegExp(`^([a-z]{3,9})${GAP}(\\d{1,2})(?:st|nd|rd|th)?${GAP}(\\d{4})$`, 'i');

/** 1-12 for "Sep", "Sept" or "September" in any case; 0 for anything else. */
function monthNumber(word) {
  const w = String(word || '').toLowerCase();
  return MONTH_NAMES.findIndex((name) => name === w || name.slice(0, 3) === w || (w === 'sept' && name === 'september')) + 1;
}

/**
 * The calendar day a cell names, as 'YYYY-MM-DD', or null when it cannot be
 * read for certain. Only what has one reading is accepted:
 *
 *   2026-09-30, 2026/09/30     year first, with a time of day after it or not
 *                              (a time with no zone is the gym's own clock,
 *                              so the day is the day written)
 *   30/09/2026, 30-9-2026      DAY first, as the template says. 09/30/2026
 *                              is not a date read this way and is refused,
 *                              never quietly turned round.
 *   30 Sep 2026, Sep 30, 2026  the month by name
 *   46295                      a spreadsheet's serial number for the day,
 *                              which is what a date cell exports as when its
 *                              column is not formatted as a date
 *
 * A two-digit year (30/09/26) is refused: it does not say which century, and
 * a date of birth can be in either.
 */
function dateKeyFrom(text) {
  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/i);
  if (m) return dateKeyOf(Number(m[1]), Number(m[2]), Number(m[3]));

  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return dateKeyOf(Number(m[3]), Number(m[2]), Number(m[1]));

  m = text.match(DAY_THEN_MONTH);
  if (m) return monthNumber(m[2]) ? dateKeyOf(Number(m[3]), monthNumber(m[2]), Number(m[1])) : null;
  m = text.match(MONTH_THEN_DAY);
  if (m) return monthNumber(m[1]) ? dateKeyOf(Number(m[3]), monthNumber(m[1]), Number(m[2])) : null;

  // Day 1 of a spreadsheet is 1 January 1900; five digits covers 1927 to 2173.
  m = text.match(/^(\d{5})(?:\.\d+)?$/);
  if (m) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(m[1]) * 86400000);
    return dateKeyOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return null;
}

/**
 * What to tell staff about a date cell that could not be read: which cell,
 * what was in it, and how to write it so that it can be. The caller ends the
 * sentence with what happened to the row.
 */
function dateProblem(label, value) {
  const text = String(value || '').trim();
  const parts = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  let why = 'Write dates as 2026-09-30 or 30/09/2026 (day first)';
  if (parts && parts[3].length === 2) {
    why = 'Write the year in full, like 30/09/2026 or 2026-09-30';
  } else if (parts && Number(parts[1]) <= 12 && Number(parts[2]) > 12) {
    why = `It looks like month/day/year, and dates are read day first: write it as ${parts[2]}/${parts[1]}/${parts[3]}`;
  }
  return `Could not read the ${label} "${text}". ${why}`;
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

function randomPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

// Without an email, a member is known by their name on their phone number.
function phoneNameKey(phone, firstName, lastName) {
  return `${phone}|${firstName} ${lastName}`.toLowerCase();
}

/**
 * The accounts the file's rows already have, read once for the whole file:
 * `{ byEmail, byPhoneName }`, each to `{ _id, needsMembership }`. Asked row
 * by row, a second upload of a large file spent its whole time on the rows
 * the first had done and never reached the rest.
 *
 * `needsMembership`: a member account with no order of any kind, under its
 * id or its email. That is what an import leaves behind when it made the
 * account but not the membership, and the only account a row adds to.
 */
async function existingAccounts(people) {
  const emails = [...new Set(people.map((p) => p.email).filter(Boolean))];
  const phones = [...new Set(people.filter((p) => !p.email && p.phone).map((p) => p.phone))];
  const either = [];
  if (emails.length) either.push({ email: { $in: emails } });
  if (phones.length) either.push({ phone: { $in: phones } });
  const users = either.length ? await User.find({ $or: either }).select('email phone firstName lastName role').lean() : [];

  const theirEmails = users.map((u) => u.email).filter(Boolean);
  const [orderedById, orderedByEmail] = await Promise.all([
    users.length ? PackageOrder.distinct('userId', { userId: { $in: users.map((u) => u._id) } }) : [],
    theirEmails.length ? PackageOrder.distinct('customerInfo.email', { 'customerInfo.email': { $in: theirEmails } }) : []
  ]);
  const hasOrder = new Set([...orderedById, ...orderedByEmail].map(String));

  const byEmail = new Map();
  const byPhoneName = new Map();
  for (const u of users) {
    const account = { _id: u._id, needsMembership: u.role === 'user' && !hasOrder.has(String(u._id)) && !hasOrder.has(String(u.email || '')) };
    if (u.email) byEmail.set(u.email, account);
    if (u.phone) byPhoneName.set(phoneNameKey(u.phone, u.firstName, u.lastName), account);
  }
  return { byEmail, byPhoneName };
}

module.exports = {
  // GET /admin/users/import/template
  template: (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gymspilotpro-members-template.csv"');
    return res.send(`${TEMPLATE_HEADER}\n${TEMPLATE_EXAMPLE}\n`);
  },

  // POST /admin/users/import   multipart: file (csv), dryRun ('1' to only report)
  importCsv: async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ success: false, message: 'Attach a CSV file' });
      }
      const dryRun = req.body && (req.body.dryRun === '1' || req.body.dryRun === 'true');
      const startedAt = Date.now();
      const budgetMs = importBudgetMs();

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
        // Accounts that were already here with no membership at all and were
        // given the one on their row (counted in `memberships` too).
        completed: 0,
        withoutEmail: 0,
        inactive: 0,
        // Which of the recognised columns this file has, so the preview can
        // say what will be read before anything is written.
        columns: Object.keys(columns),
        skipped: [],
        errors: [],
        // Whether the run stopped at its time budget, how many rows it got
        // through and how many are still to do (uploading the file again
        // carries on).
        stopped: false,
        processed: rows.length - 1,
        remaining: 0,
        dryRun: !!dryRun
      };
      const cell = (row, field) => (columns[field] === undefined ? '' : String(row[columns[field]] || '').trim());
      const seenEmails = new Set();
      const seenPhoneNames = new Set();

      const already = await existingAccounts(rows.slice(1).map((row) => ({ email: cell(row, 'email').toLowerCase(), phone: cell(row, 'phone') })));
      const plan = await checkLimit('members');
      // How many more members the gym's plan has room for; counted here as
      // rows come in rather than asked of the database for every row.
      let room = plan.limit ? plan.limit - plan.used : Infinity;

      for (let i = 1; i < rows.length; i += 1) {
        const row = rows[i];
        const line = i + 1;

        // Out of time: answer now, while there is still time to answer. Not
        // before this run has added somebody, so that every upload of the
        // file moves it on.
        if (report.created + report.completed > 0 && Date.now() - startedAt >= budgetMs) {
          report.stopped = true;
          report.remaining = rows.length - i;
          report.processed = report.total - report.remaining;
          report.errors.unshift({ line, email: '', name: 'not finished', reason: stoppedNote(report) });
          break;
        }

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

          // Without an email, the same name on the same phone number is the
          // same person: a second run of the same file must not make
          // everybody twice. (A family sharing one phone has different
          // names, so they still come in.)
          const phoneName = phoneNameKey(phone, firstName, lastName);
          if (email) {
            if (seenEmails.has(email)) {
              report.skipped.push({ line, email, name, reason: 'Duplicate email in the file' });
              continue;
            }
            seenEmails.add(email);
          } else {
            if (seenPhoneNames.has(phoneName)) {
              report.skipped.push({ line, email, name, reason: 'Duplicate name and phone in the file' });
              continue;
            }
            seenPhoneNames.add(phoneName);
          }

          const packageName = cell(row, 'package');
          const pkg = packageName ? packageByName.get(packageName.toLowerCase()) : null;

          // Already here. Skipped -- unless the account has no membership of
          // any kind and this row names one: then the row finishes what an
          // earlier import started (its membership failed, the run was cut
          // off after the account was made, or the package did not exist
          // yet). Skipping those left them without a membership for good.
          const account = (email ? already.byEmail.get(email) : already.byPhoneName.get(phoneName)) || null;
          const alreadyHere = email ? 'An account with this email already exists' : 'A member with this name and phone number already exists';
          if (account && !(pkg && account.needsMembership)) {
            report.skipped.push({ line, email, name, reason: alreadyHere });
            continue;
          }
          if (packageName && !pkg) {
            report.errors.push({ line, email, name, reason: `No package called "${packageName}" — the member is created without a membership` });
          }

          let active = account ? true : parseActive(cell(row, 'active'));
          if (active === null) {
            report.errors.push({ line, email, name, reason: `Could not read "${cell(row, 'active')}" as active or inactive — imported as active` });
            active = true;
          }

          const joinedCell = account ? '' : cell(row, 'joinedAt');
          const joinedAt = joinedCell ? parseDate(joinedCell, 'start') : null;
          if (joinedCell && !joinedAt) {
            report.errors.push({ line, email, name, reason: `${dateProblem('joining date', joinedCell)} — today is used` });
          }

          const discountCell = cell(row, 'discount');
          const discount = discountCell ? Number(discountCell.replace(/[^0-9.\-]/g, '')) : 0;
          if (discountCell && !(Number.isFinite(discount) && discount >= 0)) {
            report.errors.push({ line, email, name, reason: `Could not read the discount "${discountCell}" — none applied` });
          }

          // The membership's dates, when there is one to make: access from
          // the start of the first day to the end of the last. A date that
          // cannot be read stops the row. Left to default, it became "today
          // plus the package's term", paid and active -- a fresh term for a
          // member whose real one ran out last month, and nothing to say so.
          const startCell = pkg ? cell(row, 'startDate') : '';
          const endCell = pkg ? cell(row, 'endDate') : '';
          const start = parseDate(startCell, 'start');
          const end = parseDate(endCell, 'end');
          if ((startCell && !start) || (endCell && !end)) {
            const problem = startCell && !start ? dateProblem('membership start date', startCell) : dateProblem('membership end date', endCell);
            report.skipped.push({ line, email, name, reason: `${problem}, then upload the file again.` });
            continue;
          }
          if (start && end && end < start) {
            report.skipped.push({ line, email, name, reason: `The membership ends (${endCell}) before it starts (${startCell}). Correct the dates, then upload the file again.` });
            continue;
          }

          const dobCell = account ? '' : cell(row, 'dateOfBirth');
          const dob = parseDate(dobCell);
          if (dobCell && !dob) {
            report.errors.push({ line, email, name, reason: `${dateProblem('date of birth', dobCell)} — left blank` });
          }

          if (!account && room <= 0) {
            report.skipped.push({ line, email, name, reason: plan.message || `This gym's plan allows up to ${plan.limit} ${LIMIT_KINDS.members.label}. Upgrade the plan to add more.` });
            continue;
          }

          if (dryRun) {
            if (account) {
              report.completed += 1;
              account.needsMembership = false;
            } else {
              report.created += 1;
              room -= 1;
              if (!email) report.withoutEmail += 1;
              if (!active) report.inactive += 1;
              already.byPhoneName.set(phoneName, { needsMembership: false });
            }
            if (pkg) report.memberships += 1;
            continue;
          }

          let user = null;
          if (account) {
            // Read again, now: another upload of the same file may have got
            // to this member since the list was read.
            user = await User.findById(account._id);
            account.needsMembership = false;
            if (!user || (await PackageOrder.exists({ userId: user._id }))) {
              report.skipped.push({ line, email, name, reason: alreadyHere });
              continue;
            }
          } else {
            const memberCode = cell(row, 'memberCode');
            const codeTaken = memberCode ? await User.exists({ memberCode }) : false;
            if (memberCode && codeTaken) {
              report.errors.push({ line, email, name, reason: `Member code ${memberCode} is already in use — a new one will be assigned` });
            }

            // A quoted cell can hold line breaks; the desk's address is one line.
            const address = oneLine(cell(row, 'address')).slice(0, 300);
            const hashed = await bcrypt.hash(randomPassword(), await bcrypt.genSalt(10));
            user = await User.create({
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
            room -= 1;
            if (!email) report.withoutEmail += 1;
            if (!active) report.inactive += 1;
            // A later row with no email but this name and phone is this member.
            already.byPhoneName.set(phoneName, { _id: user._id, needsMembership: false });
          }

          if (pkg) {
            const amount = cell(row, 'amount');
            try {
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
                // These are existing members moving over from another system:
                // they joined (and paid any joining fee) there. Charging it here
                // would file part of the imported amount as admission money.
                chargeJoiningFee: false,
                // And they paid there: not today's takings, and no invoice
                // from this gym's sequence (see the order model).
                imported: true,
                notes: cell(row, 'notes') || `Imported from CSV by ${req.user && req.user.email}`,
                by: req.user && req.user.email
              });
            } catch (error) {
              // The account stays; the row is not lost. The next upload of
              // the file finds a member with no membership and adds it.
              report.errors.push({ line, email, name, reason: `${account ? 'The membership was not added' : 'Imported without the membership'}: ${String(error.message || error).replace(/\.$/, '')}. Put that right and upload the file again to add it.` });
              continue;
            }
            report.memberships += 1;
            if (account) report.completed += 1;
          }
        } catch (error) {
          report.errors.push({ line, email, name, reason: error.message });
        }
      }

      const done = dryRun
        ? `${report.created} member(s) would be created, ${report.skipped.length} skipped.`
        : `${report.created} member(s) imported, ${report.memberships} membership(s) created, ${report.skipped.length} skipped.`;
      return res.json({
        success: true,
        message: report.stopped ? `${done} ${stoppedNote(report)}` : done,
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
module.exports.dateProblem = dateProblem;
module.exports.parseActive = parseActive;
module.exports.splitFullName = splitFullName;
module.exports.importBudgetMs = importBudgetMs;
module.exports.stoppedNote = stoppedNote;
