// src/controller/adminSearchController.js
//
// The search box in the admin header: one query, answered from every part of
// the panel the caller's role can open -- members, staff, leads, package
// orders, classes and trainers -- a handful of matches each.
//
// GET /admin/search?q=
//   q   at least two characters. Several words must all match ("jo smi"
//       finds John Smith), each against any of the group's fields.
//
// -> { success, query, groups: [{ key, label, href, results: [{ id, label, sublabel, href }], has_more }] }
//
// Only groups with matches come back. Which groups are searched at all is
// decided by the account's LIVE role (requirePermission.requireStaff has
// already read it onto req.roleSlug), tab by tab, exactly as the pages
// themselves are gated: a receptionist without the Staff tab never sees a
// staff record here, even though every one of them may use the box.
//
// Every result links to the record itself: the admin page it lives on, with
// `?id=` for that page to open it (see hrefFor).

const User = require('../models/user');
const Lead = require('../models/leadModel');
const PackageOrder = require('../gymfolio/models/packageOrderModel');
const GymClass = require('../gymfolio/models/gymClassModel');
const Trainer = require('../gymfolio/models/trainerModel');
const { permissionsFor } = require('../services/roleService');
const { grants } = require('../config/permissions');

const MIN_CHARS = 2;
// Per group. The box is for jumping to something, not for browsing; a
// group with more says so and the list page does the rest.
const PER_GROUP = 5;
// Beyond this many words the extra ones narrow nothing a person would type.
const MAX_TERMS = 4;
const MAX_TERM_LENGTH = 80;

// Escaped: a search for "a.b" must not treat the dot as "any character", and
// a stray "(" must not throw.
function escapeRx(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The words to match, or null when the query is too short to search. */
function readTerms(q) {
  const text = String(q || '').trim();
  if (text.length < MIN_CHARS) return null;
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TERMS)
    .map((term) => term.slice(0, MAX_TERM_LENGTH));
}

/** Every term must match at least one of `fields`. */
function termsFilter(terms, fields) {
  return {
    $and: terms.map((term) => {
      const rx = new RegExp(escapeRx(term), 'i');
      return { $or: fields.map((field) => ({ [field]: rx })) };
    })
  };
}

const joined = (...parts) => parts.filter(Boolean).join(' · ');
const fullName = (doc) => [doc.firstName, doc.lastName].filter(Boolean).join(' ');
// 'past_due' -> 'Past due'
const statusLabel = (value) => {
  const text = String(value || '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// Where a result opens: its page, told which record to open. Each page reads
// `id` from the address -- the member's profile, the order's panel, and for
// those who may edit them the staff, lead, class or trainer form. The Leads
// board pages, so it fetches the lead on its own (GET /admin/leads/:id) and
// opens it whichever page of the board it is on.
function hrefFor(group, row) {
  return `${group.href}?${new URLSearchParams({ id: String(row._id) })}`;
}

// One entry per area of the panel. `tab` is the permission that area sits
// behind (src/config/permissions.js); `base` is what the area's own list
// shows; `view` turns a row into the two lines the dropdown prints.
const GROUPS = [
  {
    key: 'members',
    label: 'Members',
    tab: 'users',
    href: '/admin/users',
    model: User,
    base: { role: 'user' },
    fields: ['firstName', 'lastName', 'email', 'phone', 'username', 'memberCode'],
    select: 'firstName lastName email phone memberCode isActive',
    sort: { firstName: 1, lastName: 1, _id: 1 },
    view: (u) => ({
      label: fullName(u) || u.email || 'Member',
      sublabel: joined(u.memberCode, u.email, u.phone, u.isActive === false && 'disabled')
    })
  },
  {
    key: 'staff',
    label: 'Staff',
    tab: 'staff',
    href: '/admin/staff',
    model: User,
    // The Staff page's own definition of a member of staff.
    base: { 'employment.isStaff': true },
    fields: ['firstName', 'lastName', 'email', 'phone', 'username', 'staffCode', 'employment.jobTitle'],
    select: 'firstName lastName email staffCode isActive employment.jobTitle',
    sort: { firstName: 1, lastName: 1, _id: 1 },
    view: (u) => ({
      label: fullName(u) || u.email || 'Staff member',
      sublabel: joined(u.employment && u.employment.jobTitle, u.staffCode, u.email, u.isActive === false && 'disabled')
    })
  },
  {
    key: 'leads',
    label: 'Leads',
    tab: 'leads',
    href: '/admin/leads',
    model: Lead,
    // Deleted leads are only hidden; the Leads page leaves them out too.
    base: { isActive: { $ne: false } },
    fields: ['firstName', 'lastName', 'email', 'phone'],
    select: 'firstName lastName email phone status',
    sort: { updatedAt: -1, _id: -1 },
    view: (l) => ({
      label: fullName(l) || l.email || l.phone || 'Lead',
      sublabel: joined(statusLabel(l.status), l.email || l.phone)
    })
  },
  {
    key: 'orders',
    label: 'Package orders',
    tab: 'package-orders',
    href: '/admin/package-orders',
    model: PackageOrder,
    base: {},
    fields: ['orderNumber', 'invoice.number', 'customerInfo.fullName', 'customerInfo.email', 'customerInfo.phone'],
    select: 'orderNumber customerInfo.fullName customerInfo.email packageDetails.name status',
    sort: { createdAt: -1, _id: -1 },
    view: (o) => {
      const customer = (o.customerInfo && o.customerInfo.fullName) || (o.customerInfo && o.customerInfo.email) || '';
      return {
        label: joined(o.orderNumber, customer) || 'Order',
        sublabel: joined(o.packageDetails && o.packageDetails.name, statusLabel(o.status))
      };
    }
  },
  {
    key: 'classes',
    label: 'Classes',
    tab: 'classes',
    href: '/admin/classes',
    model: GymClass,
    base: {},
    fields: ['name', 'category'],
    select: 'name category difficulty isActive',
    sort: { name: 1, _id: 1 },
    view: (c) => ({
      label: c.name || 'Class',
      sublabel: joined(c.category, c.difficulty, c.isActive === false && 'inactive')
    })
  },
  {
    key: 'trainers',
    label: 'Trainers',
    tab: 'trainers',
    href: '/admin/trainers',
    model: Trainer,
    base: {},
    fields: ['name', 'email', 'phone', 'staffCode'],
    select: 'name role email phone isActive',
    sort: { name: 1, _id: 1 },
    view: (t) => ({
      label: t.name || 'Trainer',
      sublabel: joined(t.role, t.email || t.phone, t.isActive === false && 'inactive')
    })
  }
];

/** The groups a permission map may search: those whose tab it can view. */
function searchableGroups(permissions, groups = GROUPS) {
  return groups.filter((group) => grants(permissions, group.tab, 'view'));
}

/** The query for one group: what its page lists, narrowed by the terms. */
function groupFilter(group, terms) {
  return { ...group.base, ...termsFilter(terms, group.fields) };
}

/**
 * One group's answer from the rows its query returned. The query asks for
 * one row more than is shown, so "there are more" costs no count.
 */
function presentGroup(group, rows) {
  const shown = rows.slice(0, PER_GROUP);
  return {
    key: group.key,
    label: group.label,
    href: group.href,
    results: shown.map((row) => ({ id: String(row._id), ...group.view(row), href: hrefFor(group, row) })),
    has_more: rows.length > PER_GROUP
  };
}

async function searchGroup(group, terms) {
  const rows = await group.model
    .find(groupFilter(group, terms))
    .select(group.select)
    .sort(group.sort)
    .limit(PER_GROUP + 1)
    .lean();
  return presentGroup(group, rows);
}

module.exports = {
  // GET /admin/search?q=
  search: async (req, res) => {
    try {
      const query = String(req.query.q || '').trim();
      const terms = readTerms(query);
      if (!terms) return res.json({ success: true, query, groups: [] });

      const groups = searchableGroups(await permissionsFor(req.roleSlug));

      // One area failing leaves the others' answers standing: a half-full
      // dropdown is more use than an error.
      const answers = await Promise.all(
        groups.map((group) =>
          searchGroup(group, terms).catch((error) => {
            console.error(`[search] ${group.key} failed:`, error.message);
            return null;
          })
        )
      );

      return res.json({
        success: true,
        query,
        groups: answers.filter((answer) => answer && answer.results.length)
      });
    } catch (error) {
      console.error('[search] failed:', error);
      return res.status(500).json({ success: false, message: 'Search failed' });
    }
  },

  // Exported for the unit tests; not routes.
  GROUPS,
  PER_GROUP,
  readTerms,
  termsFilter,
  searchableGroups,
  groupFilter,
  hrefFor,
  presentGroup
};
