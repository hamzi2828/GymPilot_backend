// src/controller/memberOptionsController.js
//
// The member picker behind the desk screens: assigning a locker, a sale on
// the till, booking a class or a PT session, writing to one member, assigning
// a package, linking a trainer to their staff account.
//
// Those screens used to read /get/allUsers, which needs the `users` tab and
// returns every account in full. So a receptionist without that tab saw an
// empty picker with no error to explain it, and everyone else downloaded the
// whole membership to choose one name. This is the narrow version:
//
//   * any staff account may call it (requirePermission.requireStaff, like
//     /roles/options) -- picking a member is part of every desk job, and the
//     action the pick is FOR is still gated by its own tab
//   * the search runs here, a page at a time, never the whole list
//   * only what a picker shows comes back: no notes, health, documents,
//     payroll or anything else on the account
//
// GET /admin/members/options?q=&limit=&type=
//   q      name, email, phone, username or member/staff code. Several words
//          must all match ("jo smi" finds John Smith).
//   limit  default 20, at most 50
//   type   'member' (plain members), 'staff' (staff accounts), or omitted
//          for everyone
//
// Disabled accounts are left out: none of the desk actions accept one.

const User = require('../models/user');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
// Beyond this many words the extra ones narrow nothing a person would type.
const MAX_TERMS = 4;

const SEARCH_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'username', 'memberCode', 'staffCode'];

// Escaped: a search for "a.b" must not treat the dot as "any character", and
// a stray "(" must not throw.
function escapeRx(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readLimit(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

function buildFilter(query = {}) {
  const filter = { isActive: { $ne: false } };

  const type = String(query.type || '').toLowerCase().trim();
  if (type === 'member') filter.role = 'user';
  // The same test the trainer screen used for "has a staff account".
  if (type === 'staff') filter['employment.isStaff'] = true;

  const terms = String(query.q || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TERMS);

  if (terms.length) {
    filter.$and = terms.map((term) => {
      const rx = new RegExp(escapeRx(term.slice(0, 80)), 'i');
      return { $or: SEARCH_FIELDS.map((field) => ({ [field]: rx })) };
    });
  }

  return filter;
}

function optionView(user) {
  const employment = user.employment || {};
  return {
    id: String(user._id),
    name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || '',
    email: user.email || '',
    phone: user.phone || '',
    username: user.username || '',
    member_code: user.memberCode || user.staffCode || '',
    job_title: employment.isStaff ? employment.jobTitle || '' : ''
  };
}

module.exports = {
  // GET /admin/members/options
  options: async (req, res) => {
    try {
      const limit = readLimit(req.query.limit);

      // One more than asked for, so the picker can say "keep typing" when
      // there are more matches than it shows -- without a count query.
      const users = await User.find(buildFilter(req.query))
        .select('firstName lastName email phone username memberCode staffCode employment.isStaff employment.jobTitle')
        .sort({ firstName: 1, lastName: 1, _id: 1 })
        .limit(limit + 1)
        .lean();

      return res.json({
        success: true,
        data: users.slice(0, limit).map(optionView),
        has_more: users.length > limit
      });
    } catch (error) {
      console.error('[members] options failed:', error);
      return res.status(500).json({ success: false, message: 'Could not load members' });
    }
  },

  // Exported for the unit tests; not routes.
  buildFilter,
  readLimit,
  optionView
};
