// src/platform/tenantStats.js
//
// The numbers the platform panel shows next to a gym: how many people are in
// it, what it took this month, when it was last used. Read straight from the
// gym's own database inside a tenant context, the way every request does.

const { runWithTenant } = require('./tenantContext');

// A member's card subscription in the gym's OWN Stripe account that will
// charge again: live (frozen and past due included -- Stripe still holds
// them) and not already set to end with the period paid for.
const CARD_SUBSCRIPTION_FILTER = {
  'payment.stripeSubscriptionId': { $nin: [null, ''] },
  status: { $in: ['active', 'frozen', 'past_due'] },
  'subscription.cancelAtPeriodEnd': { $ne: true }
};

/**
 * How many members pay this gym by card on a subscription that is still
 * running. The platform cannot see or stop those from outside the gym, so a
 * gym deleted with any left keeps charging its members with nothing left to
 * cancel them from. Null when the gym's database could not be read.
 */
async function countCardSubscriptions(gym) {
  try {
    return await runWithTenant(gym, () => require('../gymfolio/models/packageOrderModel').countDocuments(CARD_SUBSCRIPTION_FILTER));
  } catch (error) {
    console.error(`[platform] card subscriptions of ${gym && gym.slug} could not be counted:`, error.message);
    return null;
  }
}

async function collectGymStats(gym) {
  try {
    return await runWithTenant(gym, async () => {
      const User = require('../models/user');
      const Trainer = require('../gymfolio/models/trainerModel');
      const GymClass = require('../gymfolio/models/gymClassModel');
      const PackageOrder = require('../gymfolio/models/packageOrderModel');
      const Attendance = require('../attendance/models/attendanceModel');
      const { membershipPaymentStages } = require('../accounts/services/ledger');
      const { staffCountFilter } = require('./planLimits');

      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);

      const [members, staff, trainers, classes, activeMemberships, cardSubscriptions, pendingOrders, revenue, lastVisit, lastLogin] =
        await Promise.all([
          User.countDocuments({ role: 'user' }),
          // Counted the way the plan's staff limit counts: not the owner.
          User.countDocuments(staffCountFilter(gym)),
          Trainer.countDocuments({}),
          GymClass.countDocuments({}),
          PackageOrder.countDocuments({ 'payment.status': 'paid', status: 'active' }),
          PackageOrder.countDocuments(CARD_SUBSCRIPTION_FILTER),
          PackageOrder.countDocuments({ 'payment.status': 'pending' }),
          // Every payment received this month -- the first one and each
          // renewal -- the way the gym's own accounts count it. paidAt alone
          // is the first payment only, so renewals would be missed.
          PackageOrder.aggregate([
            ...membershipPaymentStages({ start: monthStart, end: new Date(Date.now() + 60000) }),
            { $group: { _id: '$currency', total: { $sum: '$amount' }, orders: { $addToSet: '$_id' } } },
            { $sort: { total: -1 } }
          ]),
          Attendance.findOne({}, { checkInAt: 1 }).sort({ checkInAt: -1 }).lean(),
          User.findOne({ lastLogin: { $ne: null } }, { lastLogin: 1 }).sort({ lastLogin: -1 }).lean()
        ]);

      return {
        members,
        staff,
        trainers,
        classes,
        active_memberships: activeMemberships,
        // Shown in the panel's delete confirmation: these keep charging.
        card_subscriptions: cardSubscriptions,
        pending_orders: pendingOrders,
        revenue_this_month: revenue.map((row) => ({
          currency: row._id || '',
          total: Math.round((row.total || 0) * 100) / 100,
          orders: Array.isArray(row.orders) ? row.orders.length : 0
        })),
        last_visit_at: lastVisit ? lastVisit.checkInAt : null,
        last_login_at: lastLogin ? lastLogin.lastLogin : null
      };
    });
  } catch (error) {
    console.error(`[platform] stats for ${gym && gym.slug} failed:`, error.message);
    return { error: error.message };
  }
}

module.exports = { collectGymStats, countCardSubscriptions, CARD_SUBSCRIPTION_FILTER };
