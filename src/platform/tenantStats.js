// src/platform/tenantStats.js
//
// The numbers the platform panel shows next to a gym: how many people are in
// it, what it took this month, when it was last used. Read straight from the
// gym's own database inside a tenant context, the way every request does.

const { runWithTenant } = require('./tenantContext');

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

      const [members, staff, trainers, classes, activeMemberships, pendingOrders, revenue, lastVisit, lastLogin] =
        await Promise.all([
          User.countDocuments({ role: 'user' }),
          // Counted the way the plan's staff limit counts: not the owner.
          User.countDocuments(staffCountFilter(gym)),
          Trainer.countDocuments({}),
          GymClass.countDocuments({}),
          PackageOrder.countDocuments({ 'payment.status': 'paid', status: 'active' }),
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

module.exports = { collectGymStats };
