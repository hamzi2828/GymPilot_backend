// src/config/permissions.js
//
// The single list of things a role can be given access to. Every entry is one
// tab in the admin sidebar, because that is how the people using this system
// think about access: "the receptionist can see Attendance and Package Orders,
// nothing else". Inventing a second vocabulary of abstract permissions would
// mean translating between it and the sidebar on every screen.
//
// Both the backend gate (requirePermission) and the browser sidebar read this
// list, so a tab cannot exist in one and be missing from the other.

// Three levels, deliberately not two. "View" is what makes a role like an
// accountant or a shift supervisor useful: they must read the attendance and
// the orders without being able to rewrite them.
const LEVELS = ['none', 'view', 'manage'];

const LEVEL_RANK = { none: 0, view: 1, manage: 2 };

// `group` matches the sidebar heading the tab sits under, so the permission
// editor can be laid out the same way as the menu it controls.
const PERMISSION_TABS = [
  { key: 'dashboard',      label: 'Dashboard',       group: 'Overview',  path: '/admin' },

  { key: 'classes',        label: 'Classes',         group: 'Fitness',   path: '/admin/classes' },
  { key: 'trainers',       label: 'Trainers',        group: 'Fitness',   path: '/admin/trainers' },
  { key: 'packages',       label: 'Packages',        group: 'Fitness',   path: '/admin/packages' },

  { key: 'package-orders', label: 'Package Orders',  group: 'Sales',     path: '/admin/package-orders' },
  { key: 'registrations',  label: 'Registrations',   group: 'Sales',     path: '/admin/package-registrations' },

  { key: 'attendance',     label: 'Attendance',      group: 'Operations', path: '/admin/attendance' },
  { key: 'accounts',       label: 'Accounts',        group: 'Operations', path: '/admin/accounts' },
  { key: 'staff',          label: 'Staff',           group: 'Operations', path: '/admin/staff' },
  { key: 'roles',          label: 'Roles & Access',  group: 'Operations', path: '/admin/roles' },

  { key: 'users',          label: 'Users',           group: 'Customers', path: '/admin/users' },
  { key: 'contact-queries',label: 'Contact Queries', group: 'Customers', path: '/admin/contact-queries' },

  { key: 'homepage',       label: 'Homepage',        group: 'Content',   path: '/admin/homepage' },
  { key: 'hero-slides',    label: 'Hero Slides',     group: 'Content',   path: '/admin/hero-slides' },
  { key: 'testimonials',   label: 'Testimonials',    group: 'Content',   path: '/admin/testimonials' },
  { key: 'blogs',          label: 'Blogs',           group: 'Content',   path: '/admin/blogs' },
  { key: 'blog-settings',  label: 'Blog Settings',   group: 'Content',   path: '/admin/blog-settings' },

  { key: 'settings',       label: 'Settings',        group: 'System',    path: '/admin/settings' }
];

const TAB_KEYS = PERMISSION_TABS.map((tab) => tab.key);

function isTab(key) {
  return TAB_KEYS.includes(key);
}

function normaliseLevel(level) {
  return LEVELS.includes(level) ? level : 'none';
}

// Every tab present, so a role document is never half-defined and a tab added
// later defaults to closed rather than to whatever the Map happens to hold.
function fullPermissionMap(source = {}) {
  const map = {};
  const read = source instanceof Map ? (key) => source.get(key) : (key) => source[key];
  for (const key of TAB_KEYS) map[key] = normaliseLevel(read(key));
  return map;
}

function allowAll() {
  const map = {};
  for (const key of TAB_KEYS) map[key] = 'manage';
  return map;
}

function grants(permissions, tab, required = 'view') {
  if (!permissions) return false;
  const held = permissions instanceof Map ? permissions.get(tab) : permissions[tab];
  return LEVEL_RANK[normaliseLevel(held)] >= LEVEL_RANK[normaliseLevel(required)];
}

module.exports = {
  LEVELS,
  LEVEL_RANK,
  PERMISSION_TABS,
  TAB_KEYS,
  isTab,
  normaliseLevel,
  fullPermissionMap,
  allowAll,
  grants
};
