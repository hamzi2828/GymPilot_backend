// src/controller/dashboardController.js
//
// What an owner wants to know when they open the panel: is money coming in,
// how many members do we actually have, who is about to lapse, who is in the
// building, and what is on today.
//
// The screen this replaces showed five row counts -- classes, trainers,
// packages, orders, registrations -- none of which answer any of those
// questions. Two of them were also wrong, because they counted the rows in a
// paginated response rather than asking for the total.
//
// Everything here is read-only and derived. Nothing new is stored: revenue
// comes from the same PackageOrder rows the accounts screen totals, membership
// counts come from the same subscription dates the front desk reads, and
// attendance comes from the same collection the desktop app writes. One set of
// numbers, so the dashboard cannot disagree with the screen it links to.

const PackageOrder = require('../gymfolio/models/packageOrderModel');
const ClassBooking = require('../gymfolio/models/classBookingModel');
const GymClass = require('../gymfolio/models/gymClassModel');
const Trainer = require('../gymfolio/models/trainerModel');
const Package = require('../gymfolio/models/packageModel');
const PackageRegistration = require('../gymfolio/models/packageRegistrationModel');
const Attendance = require('../attendance/models/attendanceModel');
const Contact = require('../models/contactModel');
const Sale = require('../models/saleModel');
const User = require('../models/user');
const L = require('../accounts/services/ledger');
const T = require('../attendance/services/timeUtils');
const sessions = require('../gymfolio/services/classSessions');
const { sweepIfDue, liveFilter, countLiveMembers } = require('../gymfolio/services/membershipExpiry');

// A membership inside this window is "expiring" -- close enough that somebody
// should be chasing it, far enough out that chasing is still useful.
const EXPIRING_WINDOW_DAYS = 14;

function startOfLocalDay(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  const parts = T.localParts(guess);
  let drift = parts.hour * 60 + parts.minute;
  if (drift > 720) drift -= 1440;
  return new Date(guess.getTime() - drift * 60000);
}

/**
 * Live / expiring / lapsed, counted from the subscription dates themselves.
 *
 * People, not orders, and the same definition of "live" the reports use
 * (membershipExpiry.liveFilter): frozen and past-due members are still
 * members, and one person holding two live orders is one member.
 */
async function membershipCounts(now) {
  const soon = new Date(now.getTime() + EXPIRING_WINDOW_DAYS * 86400000);

  const [active, expiring, lapsed, neverBought] = await Promise.all([
    countLiveMembers(now),
    countLiveMembers(now, { 'subscription.endDate': { $gte: now, $lt: soon } }),
    // Lapsed: people whose membership ran out (or was cancelled) and who
    // have nothing live now -- a member who renewed is not lapsed.
    (async () => {
      const [liveIds, everLapsed] = await Promise.all([
        PackageOrder.distinct('userId', liveFilter(now)),
        PackageOrder.distinct('userId', { 'payment.status': 'paid', status: { $in: ['expired', 'cancelled'] } })
      ]);
      const live = new Set(liveIds.filter(Boolean).map(String));
      return everLapsed.filter(Boolean).filter((id) => !live.has(String(id))).length;
    })(),
    // Members with an account and no paid order at all. The gap between
    // "signed up" and "bought something" is the one a gym can actually close.
    (async () => {
      const withOrders = await PackageOrder.distinct('userId', { 'payment.status': 'paid' });
      return User.countDocuments({
        role: 'user',
        isActive: true,
        _id: { $nin: withOrders.filter(Boolean) }
      });
    })()
  ]);

  return { active, expiring, lapsed, never_bought: neverBought };
}

module.exports = {
  // GET /admin/dashboard
  overview: async (req, res) => {
    try {
      const now = new Date();
      const today = T.dateKey();
      const base = await L.baseCurrency();

      // Same housekeeping the orders screens do, so the counts below cannot be
      // computed from statuses that should already have lapsed.
      await sweepIfDue();

      const monthStart = `${today.slice(0, 7)}-01`;
      const range = L.readRange({ from: monthStart, to: today });
      const dayStart = startOfLocalDay(today);

      const [
        revenueRows,
        shopRows,
        memberships,
        todayAttendance,
        openContacts,
        pendingRegistrations,
        catalogue,
        todaysSessions,
        recentJoins,
        expiringSoon
      ] = await Promise.all([
        // Money in this month, per currency -- never summed across them.
        PackageOrder.aggregate([
          {
            $match: {
              'payment.status': 'paid',
              $expr: {
                $and: [
                  { $gte: [{ $ifNull: ['$payment.paidAt', '$createdAt'] }, range.start] },
                  { $lt: [{ $ifNull: ['$payment.paidAt', '$createdAt'] }, range.end] }
                ]
              }
            }
          },
          { $group: { _id: '$payment.currency', total: { $sum: '$payment.amount' }, n: { $sum: 1 } } }
        ]),

        // Till sales are money in beside memberships, as the accounts
        // overview already counts them.
        Sale.aggregate([
          { $match: { status: 'paid', paidAt: { $gte: range.start, $lt: range.end } } },
          { $group: { _id: '$currency', total: { $sum: '$total' }, n: { $sum: 1 } } }
        ]).catch(() => []),

        membershipCounts(now),

        // Distinct people, not rows: somebody who came in twice today is one
        // person in the building, and is "still in" if any visit is open.
        Attendance.aggregate([
          { $match: { shiftDate: today } },
          {
            $group: {
              _id: { type: '$personType', person: '$personId' },
              open: { $max: { $cond: [{ $eq: ['$checkOutAt', null] }, 1, 0] } }
            }
          },
          { $group: { _id: '$_id.type', n: { $sum: 1 }, open: { $sum: '$open' } } }
        ]),

        Contact.countDocuments({ status: { $in: ['new', 'pending', 'open'] } }).catch(() => 0),
        PackageRegistration.countDocuments({ status: 'pending' }).catch(() => 0),

        Promise.all([
          GymClass.countDocuments({ isActive: true }),
          Trainer.countDocuments({ isActive: true }),
          Package.countDocuments({ isActive: true }),
          User.countDocuments({ role: 'user', isActive: true })
        ]),

        // Today's timetable with live booking counts.
        sessions.timetable({ from: today, to: today }).catch(() => ({ sessions: [] })),

        User.find({ role: 'user' })
          .sort({ createdAt: -1 })
          .limit(5)
          .select('firstName lastName email createdAt memberCode')
          .lean(),

        PackageOrder.find({
          ...liveFilter(now),
          'subscription.endDate': { $gte: now, $lt: new Date(now.getTime() + EXPIRING_WINDOW_DAYS * 86400000) }
        })
          .sort({ 'subscription.endDate': 1 })
          .limit(8)
          .select('orderNumber customerInfo packageDetails subscription userId')
          .lean()
      ]);

      // Three totals, each per currency: memberships, the shop, and the two
      // together -- which is what "revenue" has always meant on the accounts
      // screen this links to.
      const membershipRevenue = {};
      const shopRevenue = {};
      const revenue = {};
      let paidOrders = 0;
      let shopSales = 0;
      for (const row of revenueRows) {
        const code = String(row._id || base).toUpperCase();
        L.addTo(membershipRevenue, code, row.total || 0);
        L.addTo(revenue, code, row.total || 0);
        paidOrders += row.n;
      }
      for (const row of shopRows) {
        const code = String(row._id || base).toUpperCase();
        L.addTo(shopRevenue, code, row.total || 0);
        L.addTo(revenue, code, row.total || 0);
        shopSales += row.n;
      }

      const attendance = { member: 0, staff: 0, still_in: 0 };
      for (const row of todayAttendance) {
        if (row._id === 'staff') attendance.staff = row.n;
        else attendance.member = row.n;
        attendance.still_in += row.open;
      }

      const [classCount, trainerCount, packageCount, memberCount] = catalogue;

      const sessionList = (todaysSessions.sessions || []).map((s) => ({
        class_name: s.class_name,
        start_time: s.start_time,
        end_time: s.end_time,
        instructor_name: s.instructor_name,
        capacity: s.capacity,
        booked: s.booked_count,
        waitlist: s.waitlist_count,
        is_closed: s.is_closed
      }));

      return res.json({
        success: true,
        today,
        timezone: T.TIMEZONE,
        base_currency: base,

        revenue: {
          ...L.presentTotals(revenue, base),
          orders: paidOrders,
          sales: shopSales,
          period: range.label,
          note: 'Membership sales and shop takings recorded in this system'
        },
        membership_revenue: {
          ...L.presentTotals(membershipRevenue, base),
          orders: paidOrders,
          period: range.label
        },
        shop_revenue: {
          ...L.presentTotals(shopRevenue, base),
          sales: shopSales,
          period: range.label
        },

        members: {
          total: memberCount,
          ...memberships,
          expiring_window_days: EXPIRING_WINDOW_DAYS
        },

        attendance_today: attendance,

        classes_today: {
          count: sessionList.length,
          booked: sessionList.reduce((sum, s) => sum + s.booked, 0),
          sessions: sessionList
        },

        // The things a person has to act on, rather than merely look at.
        needs_attention: {
          expiring_memberships: memberships.expiring,
          open_contact_queries: openContacts,
          pending_registrations: pendingRegistrations
        },

        catalogue: {
          classes: classCount,
          trainers: trainerCount,
          packages: packageCount
        },

        recent_members: recentJoins.map((u) => ({
          id: String(u._id),
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
          email: u.email,
          code: u.memberCode || '',
          joined: u.createdAt
        })),

        expiring_soon: expiringSoon.map((o) => ({
          order_number: o.orderNumber,
          user_id: o.userId ? String(o.userId) : null,
          name: (o.customerInfo && o.customerInfo.fullName) || '',
          email: (o.customerInfo && o.customerInfo.email) || '',
          package: (o.packageDetails && o.packageDetails.name) || '',
          ends: o.subscription && o.subscription.endDate,
          days_left: o.subscription && o.subscription.endDate
            ? Math.ceil((new Date(o.subscription.endDate) - now) / 86400000)
            : null
        }))
      });
    } catch (error) {
      console.error('dashboard error:', error);
      return res.status(500).json({ success: false, message: 'Could not load the dashboard', error: error.message });
    }
  }
};
