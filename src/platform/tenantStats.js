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

      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);

      const [members, staff, trainers, classes, activeMemberships, pendingOrders, revenue, lastVisit, lastLogin] =
        await Promise.all([
          User.countDocuments({ role: 'user' }),
          User.countDocuments({ 'employment.isStaff': true }),
          Trainer.countDocuments({}),
          GymClass.countDocuments({}),
          PackageOrder.countDocuments({ 'payment.status': 'paid', status: 'active' }),
          PackageOrder.countDocuments({ 'payment.status': 'pending' }),
          PackageOrder.aggregate([
            { $match: { 'payment.status': 'paid', 'payment.paidAt': { $gte: monthStart } } },
            { $group: { _id: { $toUpper: '$payment.currency' }, total: { $sum: '$payment.amount' }, orders: { $sum: 1 } } },
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
          orders: row.orders
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
