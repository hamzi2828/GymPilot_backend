// src/services/roleService.js
//
// Turns "who is this request from" into "what may they touch".
//
// Two things make this more than a findOne:
//
//   * Permissions are read on EVERY gated request, so the role documents are
//     cached briefly. Without it, a page that loads six admin endpoints costs
//     six identical role lookups.
//
//   * The 'admin' slug is all-access in code, not in data. A role document
//     whose permissions were accidentally cleared must never be able to lock
//     the last administrator out of the panel that would let them fix it.

const Role = require('../models/roleModel');
const { allowAll, fullPermissionMap, grants } = require('../config/permissions');
const { tenantKey } = require('../platform/tenantContext');

const ADMIN_SLUG = 'admin';
const MEMBER_SLUG = 'user';

// Short enough that a permission change is live almost immediately, long
// enough to collapse the burst of calls one admin page makes.
const CACHE_TTL_MS = 15000;

// One cache per gym: every gym has its own roles in its own database, and a
// Manager in one gym must never be read as a Manager in another.
const caches = new Map(); // tenantKey -> { at, bySlug }

function invalidate() {
  caches.delete(tenantKey());
}

async function loadRoles() {
  const key = tenantKey();
  const cache = caches.get(key);
  if (cache && cache.at && Date.now() - cache.at < CACHE_TTL_MS) return cache.bySlug;

  const roles = await Role.find({ isActive: true }).lean();
  const bySlug = new Map();
  for (const role of roles) bySlug.set(role.slug, role);

  caches.set(key, { at: Date.now(), bySlug });
  return bySlug;
}

// The roles that ship with the system. Created once, then owned by the gym --
// this never overwrites an existing role, so a permission an admin has changed
// stays changed across restarts.
const DEFAULT_ROLES = [
  {
    name: 'Administrator',
    slug: ADMIN_SLUG,
    description: 'Full access to everything, including roles and settings.',
    isStaff: true,
    isSystem: true,
    order: 0,
    permissions: allowAll()
  },
  {
    name: 'Member',
    slug: MEMBER_SLUG,
    description: 'A gym member. No access to the admin panel.',
    isStaff: false,
    isSystem: true,
    order: 100,
    permissions: fullPermissionMap()
  },
  {
    name: 'Manager',
    slug: 'manager',
    description: 'Runs the gym day to day. Everything except roles and system settings.',
    isStaff: true,
    order: 1,
    permissions: fullPermissionMap({
      dashboard: 'view',
      classes: 'manage',
      pt: 'manage',
      trainers: 'manage',
      packages: 'manage',
      'package-orders': 'manage',
      registrations: 'manage',
      coupons: 'manage',
      attendance: 'manage',
      accounts: 'manage',
      staff: 'manage',
      roles: 'view',
      users: 'manage',
      'contact-queries': 'manage',
      leads: 'manage',
      messaging: 'manage',
      homepage: 'view',
      'hero-slides': 'view',
      testimonials: 'manage',
      blogs: 'manage',
      'blog-settings': 'view',
      settings: 'view',
      audit: 'view'
    })
  },
  {
    name: 'Receptionist',
    slug: 'receptionist',
    description: 'Front desk: attendance, memberships and enquiries.',
    isStaff: true,
    order: 2,
    permissions: fullPermissionMap({
      dashboard: 'view',
      classes: 'view',
      pt: 'manage',
      trainers: 'view',
      packages: 'view',
      'package-orders': 'manage',
      registrations: 'manage',
      coupons: 'view',
      attendance: 'manage',
      users: 'manage',
      'contact-queries': 'manage',
      leads: 'manage',
      messaging: 'manage'
    })
  },
  {
    name: 'Trainer',
    slug: 'trainer',
    description: 'Coaching staff. Sees the timetable and their own attendance.',
    isStaff: true,
    order: 3,
    permissions: fullPermissionMap({
      dashboard: 'view',
      classes: 'view',
      pt: 'view',
      trainers: 'view',
      attendance: 'view'
    })
  },
  {
    name: 'Cleaner',
    slug: 'cleaner',
    description: 'Facilities staff. Clocks in and out; no admin access.',
    isStaff: true,
    order: 4,
    permissions: fullPermissionMap()
  },
  {
    name: 'Accountant',
    slug: 'accountant',
    description: 'Reads the money and the hours, changes neither.',
    isStaff: true,
    order: 5,
    permissions: fullPermissionMap({
      dashboard: 'view',
      'package-orders': 'view',
      registrations: 'view',
      attendance: 'view',
      accounts: 'manage',
      staff: 'view',
      packages: 'view'
    })
  }
];

async function ensureDefaultRoles() {
  const existing = await Role.find().select('slug').lean();
  const known = new Set(existing.map((role) => role.slug));

  const missing = DEFAULT_ROLES.filter((role) => !known.has(role.slug));
  if (!missing.length) return 0;

  await Role.insertMany(missing);
  invalidate();
  return missing.length;
}

// The effective permission map for a role slug. Unknown or inactive roles get
// nothing rather than falling back to something permissive.
async function permissionsFor(slug) {
  if (slug === ADMIN_SLUG) return allowAll();

  const roles = await loadRoles();
  const role = roles.get(slug);
  if (!role) return fullPermissionMap();

  return fullPermissionMap(role.permissions);
}

async function roleFor(slug) {
  if (!slug) return null;
  const roles = await loadRoles();
  return roles.get(slug) || null;
}

async function can(slug, tab, level = 'view') {
  if (slug === ADMIN_SLUG) return true;
  return grants(await permissionsFor(slug), tab, level);
}

module.exports = {
  ADMIN_SLUG,
  MEMBER_SLUG,
  DEFAULT_ROLES,
  ensureDefaultRoles,
  permissionsFor,
  roleFor,
  can,
  invalidate
};
