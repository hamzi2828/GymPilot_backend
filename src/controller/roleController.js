// src/controller/roleController.js
//
// CRUD for roles, plus the two reads the admin panel needs before it can draw
// anything: the catalogue of tabs a permission can be set on, and the signed-in
// account's own effective permissions.
//
// The guards here are all about not locking anybody out. A role system whose
// worst failure mode is "nobody can reach the screen that would fix it" is
// worse than no role system, so:
//
//   * system roles cannot be deleted or renamed at the slug level
//   * the 'admin' role's permissions cannot be reduced
//   * a role still assigned to accounts cannot be deleted out from under them

const mongoose = require('mongoose');

const Role = require('../models/roleModel');
const User = require('../models/user');
const {
  PERMISSION_TABS,
  LEVELS,
  fullPermissionMap,
  allowAll
} = require('../config/permissions');
const {
  ADMIN_SLUG,
  MEMBER_SLUG,
  ensureDefaultRoles,
  permissionsFor,
  invalidate
} = require('../services/roleService');

const SLUG_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function shapeRole(role, memberCount = 0) {
  const permissions = fullPermissionMap(role.permissions);
  const granted = Object.values(permissions).filter((level) => level !== 'none').length;

  return {
    id: String(role._id),
    name: role.name,
    slug: role.slug,
    description: role.description || '',
    is_staff: !!role.isStaff,
    is_system: !!role.isSystem,
    is_active: role.isActive !== false,
    order: role.order || 0,
    permissions,
    granted_tabs: granted,
    member_count: memberCount
  };
}

module.exports = {
  // GET /api/roles/catalog
  //
  // What a permission can be set ON and set TO. Served rather than duplicated
  // in the browser so a tab added to the backend list appears in the editor
  // without a frontend release.
  catalog: async (_req, res) => {
    return res.json({
      success: true,
      levels: LEVELS,
      tabs: PERMISSION_TABS
    });
  },

  // GET /api/roles/options
  //
  // Just the names, for the role pickers on the Users and Staff tabs. Open to
  // any staff account (see requirePermission.requireStaff), because a
  // receptionist who may edit users must be able to pick a role without
  // holding the `roles` tab that would let them edit the roles themselves.
  options: async (_req, res) => {
    try {
      await ensureDefaultRoles();
      const roles = await Role.find({ isActive: true }).select('slug name order isStaff').sort({ order: 1, name: 1 }).lean();
      // is_staff lets the Staff page offer staff roles only.
      return res.json({
        success: true,
        data: roles.map((role) => ({ slug: role.slug, name: role.name, is_staff: role.isStaff !== false }))
      });
    } catch (error) {
      console.error('[roles] options failed:', error);
      return res.status(500).json({ message: 'Could not load roles', error: error.message });
    }
  },

  // GET /api/roles
  list: async (_req, res) => {
    try {
      const created = await ensureDefaultRoles();
      if (created) console.log(`[roles] seeded ${created} default role(s)`);

      const roles = await Role.find().sort({ order: 1, name: 1 }).lean();

      // One grouped count rather than a countDocuments per role.
      const counts = await User.aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }]);
      const bySlug = new Map(counts.map((entry) => [entry._id, entry.n]));

      return res.json({
        success: true,
        roles: roles.map((role) => shapeRole(role, bySlug.get(role.slug) || 0))
      });
    } catch (error) {
      console.error('[roles] list failed:', error);
      return res.status(500).json({ message: 'Could not load roles', error: error.message });
    }
  },

  // GET /api/roles/me
  //
  // Not permission-gated: every signed-in account may ask what it can do, and
  // the admin shell needs the answer before it can decide whether to render at
  // all.
  me: async (req, res) => {
    try {
      const account = await User.findById(req.user.id)
        .select('firstName lastName email role isActive employment.isStaff employment.jobTitle')
        .lean();

      if (!account) return res.status(401).json({ message: 'Account no longer exists' });
      if (account.isActive === false) return res.status(403).json({ message: 'Account is disabled' });

      await ensureDefaultRoles();
      const permissions = await permissionsFor(account.role);
      const role = await Role.findOne({ slug: account.role }).lean();

      // Whether the gym has been set up. The admin shell shows the wizard
      // banner to anyone who can change settings until it has.
      let setupCompleted = true;
      try {
        const Settings = require('../models/settings');
        const settings = await Settings.getSettings();
        setupCompleted = !!(settings && settings.setupCompletedAt);
      } catch {
        setupCompleted = true;
      }

      return res.json({
        success: true,
        user: {
          id: String(account._id),
          name: [account.firstName, account.lastName].filter(Boolean).join(' ').trim(),
          email: account.email,
          role: account.role,
          role_name: role ? role.name : account.role === ADMIN_SLUG ? 'Administrator' : account.role,
          is_staff: !!(account.employment && account.employment.isStaff),
          job_title: (account.employment && account.employment.jobTitle) || '',
          setup_completed: setupCompleted
        },
        permissions,
        // A convenience the sidebar would otherwise recompute on every render.
        tabs: PERMISSION_TABS.filter((tab) => permissions[tab.key] !== 'none').map((tab) => tab.key)
      });
    } catch (error) {
      console.error('[roles] me failed:', error);
      return res.status(500).json({ message: 'Could not load permissions', error: error.message });
    }
  },

  // POST /api/roles
  create: async (req, res) => {
    try {
      const { name, description, isStaff, permissions, order } = req.body || {};

      if (!name || !String(name).trim()) {
        return res.status(400).json({ message: 'A role name is required' });
      }

      const slug = slugify(req.body.slug || name);
      if (!SLUG_RX.test(slug)) {
        return res.status(400).json({ message: 'That name does not make a usable role key' });
      }

      const clash = await Role.findOne({ slug });
      if (clash) return res.status(409).json({ message: `A role with the key "${slug}" already exists` });

      const role = await Role.create({
        name: String(name).trim(),
        slug,
        description: String(description || '').trim(),
        isStaff: isStaff !== false,
        isSystem: false,
        permissions: fullPermissionMap(permissions || {}),
        order: Number(order) || 50
      });

      invalidate();
      return res.status(201).json({ success: true, message: 'Role created', role: shapeRole(role) });
    } catch (error) {
      console.error('[roles] create failed:', error);
      return res.status(400).json({ message: 'Could not create the role', error: error.message });
    }
  },

  // PUT /api/roles/:id
  update: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid role id' });
      }

      const role = await Role.findById(id);
      if (!role) return res.status(404).json({ message: 'Role not found' });

      const { name, description, isStaff, permissions, isActive, order } = req.body || {};

      if (name !== undefined) role.name = String(name).trim() || role.name;
      if (description !== undefined) role.description = String(description).trim();
      if (order !== undefined) role.order = Number(order) || 0;

      // A system role's shape is load-bearing: 'admin' must stay all-access and
      // staff, 'user' must stay a member role, or the panel and the attendance
      // roster start disagreeing about who works here.
      if (!role.isSystem) {
        if (isStaff !== undefined) role.isStaff = !!isStaff;
        if (isActive !== undefined) role.isActive = !!isActive;
      }

      if (permissions !== undefined) {
        role.permissions =
          role.slug === ADMIN_SLUG ? allowAll() : fullPermissionMap(permissions);
      }

      await role.save();
      invalidate();

      return res.json({ success: true, message: 'Role updated', role: shapeRole(role) });
    } catch (error) {
      console.error('[roles] update failed:', error);
      return res.status(400).json({ message: 'Could not update the role', error: error.message });
    }
  },

  // DELETE /api/roles/:id
  remove: async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid role id' });
      }

      const role = await Role.findById(id);
      if (!role) return res.status(404).json({ message: 'Role not found' });

      if (role.isSystem || role.slug === ADMIN_SLUG || role.slug === MEMBER_SLUG) {
        return res.status(400).json({ message: 'System roles cannot be deleted' });
      }

      // Deleting a role out from under its holders would leave accounts
      // pointing at a slug that resolves to no permissions -- locked out with
      // no visible cause. Reassign first.
      const holders = await User.countDocuments({ role: role.slug });
      if (holders) {
        return res.status(409).json({
          message: `${holders} account${holders === 1 ? ' is' : 's are'} still using this role. Move them to another role first.`
        });
      }

      await role.deleteOne();
      invalidate();

      return res.json({ success: true, message: 'Role deleted' });
    } catch (error) {
      console.error('[roles] delete failed:', error);
      return res.status(400).json({ message: 'Could not delete the role', error: error.message });
    }
  }
};
