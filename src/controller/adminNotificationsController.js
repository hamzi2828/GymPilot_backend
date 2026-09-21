// src/controller/adminNotificationsController.js
//
// The bell in the admin header: how many things are waiting for somebody on
// the staff to act on them, and where to go to do it.
//
// GET /admin/notifications
// -> { success, data: [{ key, label, count, href }], total }
//
// Counts only, and only the ones worth a click: an item whose count is zero
// is left out, so an empty list means nothing is waiting. Each item belongs
// to a permission tab and is counted only for an account whose LIVE role can
// view it (requirePermission.requireStaff has read the role onto
// req.roleSlug) -- the bell must not tell a trainer how many bank transfers
// are pending, or link them to a page that will refuse them.
//
// Everything is read from the same fields the pages it links to show, and
// where the dashboard already counts the same thing ("needs attention") it
// is counted the same way here, so the bell and the dashboard agree. Each
// link opens its page already filtered to what was counted, wherever that
// page's list can filter that way; the one it cannot yet (memberships
// ending) opens the plain list.

const PackageOrder = require('../gymfolio/models/packageOrderModel');
const PackageRegistration = require('../gymfolio/models/packageRegistrationModel');
const Contact = require('../models/contactModel');
const Lead = require('../models/leadModel');
const LeaveRequest = require('../models/leaveRequestModel');
const { followUpCutoff, followUpDueFilter } = require('./leadController');
const { sweepIfDue, countLiveMembers } = require('../gymfolio/services/membershipExpiry');
const { permissionsFor } = require('../services/roleService');
const { grants } = require('../config/permissions');

// Memberships ending inside this window are worth chasing now. Shorter than
// the dashboard's fortnight on purpose: the bell is for this week's work.
const EXPIRING_WINDOW_DAYS = 7;

// The dashboard's "unanswered enquiries" filter, kept identical.
const OPEN_CONTACT = { status: { $in: ['new', 'pending', 'open'] } };

// In the order the bell lists them: money first, then people waiting on a
// reply, then the week ahead. `count(now)` resolves to a number.
const CHECKS = [
  {
    key: 'failed_payments',
    label: 'Failed card payments',
    tab: 'package-orders',
    href: '/admin/package-orders?status=past_due',
    // A Stripe renewal failed and Stripe is retrying (gymfolioPaymentService).
    count: () => PackageOrder.countDocuments({ status: 'past_due' })
  },
  {
    key: 'bank_transfers',
    label: 'Bank transfers to confirm',
    tab: 'package-orders',
    href: '/admin/package-orders?status=pending&paymentStatus=processing&paymentMethod=bank_transfer',
    // The member has sent the receipt (membershipService.submitTransferProof)
    // and nobody has approved or rejected it yet.
    count: () =>
      PackageOrder.countDocuments({
        'payment.method': 'bank_transfer',
        'payment.status': 'processing',
        'payment.proof.uploadedAt': { $ne: null },
        status: 'pending'
      })
  },
  {
    key: 'contact_queries',
    label: 'New contact queries',
    tab: 'contact-queries',
    // Of OPEN_CONTACT's three statuses 'new' is the only one the contact
    // model can hold, so this is the same set.
    href: '/admin/contact-queries?status=new',
    count: () => Contact.countDocuments(OPEN_CONTACT)
  },
  {
    key: 'registrations',
    label: 'Registrations to follow up',
    tab: 'registrations',
    href: '/admin/package-registrations?status=pending',
    count: () => PackageRegistration.countDocuments({ status: 'pending' })
  },
  {
    key: 'lead_follow_ups',
    label: 'Lead follow-ups due',
    tab: 'leads',
    // The board's "due for follow-up" filter, which lists the same leads by
    // the same rule (leadController.followUpDueFilter) as counted here.
    href: '/admin/leads?due=1',
    count: () => Lead.countDocuments(followUpDueFilter())
  },
  {
    key: 'leave_requests',
    label: 'Leave requests to decide',
    tab: 'staff',
    href: '/admin/staff/leave?status=pending',
    count: () => LeaveRequest.countDocuments({ status: 'pending' })
  },
  {
    key: 'expiring_memberships',
    label: `Memberships ending within ${EXPIRING_WINDOW_DAYS} days`,
    tab: 'package-orders',
    // Nor has the orders list an end-date filter.
    href: '/admin/package-orders',
    // People, not orders, by the dashboard's definition of "live".
    count: (now) =>
      countLiveMembers(now, {
        'subscription.endDate': { $gte: now, $lt: new Date(now.getTime() + EXPIRING_WINDOW_DAYS * 86400000) }
      })
  }
];

/** The checks a permission map may see: those whose tab it can view. */
function visibleChecks(permissions, checks = CHECKS) {
  return checks.filter((check) => grants(permissions, check.tab, 'view'));
}

/** The bell's items from the counts, in check order, zeros left out. */
function presentItems(checks, counts) {
  return checks
    .map((check, i) => ({ key: check.key, label: check.label, count: Number(counts[i]) || 0, href: check.href }))
    .filter((item) => item.count > 0);
}

module.exports = {
  // GET /admin/notifications
  list: async (req, res) => {
    try {
      const checks = visibleChecks(await permissionsFor(req.roleSlug));

      // Same housekeeping the dashboard does first, so a membership that has
      // already lapsed is not counted as failing or as ending soon.
      if (checks.some((check) => check.tab === 'package-orders')) await sweepIfDue();

      const now = new Date();
      // One count failing costs that item, not the bell.
      const counts = await Promise.all(
        checks.map((check) =>
          Promise.resolve()
            .then(() => check.count(now))
            .catch((error) => {
              console.error(`[notifications] ${check.key} failed:`, error.message);
              return 0;
            })
        )
      );

      const data = presentItems(checks, counts);
      return res.json({ success: true, data, total: data.reduce((sum, item) => sum + item.count, 0) });
    } catch (error) {
      console.error('[notifications] failed:', error);
      return res.status(500).json({ success: false, message: 'Could not load notifications' });
    }
  },

  // Exported for the unit tests; not routes.
  CHECKS,
  EXPIRING_WINDOW_DAYS,
  followUpCutoff,
  visibleChecks,
  presentItems
};
