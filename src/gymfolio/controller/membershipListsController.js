// src/gymfolio/controller/membershipListsController.js
//
// The front desk's member lists, built on services/membershipLists.js:
// who owes money, whose membership ends soon, whose has ended without a
// renewal, and what a set of members currently hold. Staff only
// (package-orders · view on the routes). The lists sweep lapsed orders
// first (throttled), so the statuses they show are today's.

const lists = require('../services/membershipLists');
const { MembershipError } = require('../services/membershipService');
const { sweepIfDue } = require('../services/membershipExpiry');

function fail(res, error) {
  if (error instanceof MembershipError) {
    return res.status(error.status || 400).json({ success: false, message: error.message, code: error.code || undefined });
  }
  console.error('[membership lists]', error);
  return res.status(500).json({ success: false, message: 'Could not load the list' });
}

module.exports = {
  // GET /api/gymfolio/package-orders/dues?search=&page=&limit=
  dues: async (req, res) => {
    try {
      await sweepIfDue();
      const { rows, totals, pagination } = await lists.duesList(req.query || {});
      return res.json({ success: true, data: rows, totals, pagination });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/gymfolio/package-orders/expiring?days=7&includeAutoRenew=0&search=&page=&limit=
  expiring: async (req, res) => {
    try {
      await sweepIfDue();
      const q = req.query || {};
      const { rows, days, pagination } = await lists.expiringList({
        days: q.days,
        includeAutoRenew: q.includeAutoRenew === '1' || q.includeAutoRenew === 'true',
        search: q.search,
        page: q.page,
        limit: q.limit
      });
      return res.json({ success: true, data: rows, days, pagination });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/gymfolio/package-orders/expired?withinDays=&search=&page=&limit=
  expired: async (req, res) => {
    try {
      await sweepIfDue();
      const q = req.query || {};
      const { rows, pagination } = await lists.expiredList({ withinDays: q.withinDays, search: q.search, page: q.page, limit: q.limit });
      return res.json({ success: true, data: rows, pagination });
    } catch (error) {
      return fail(res, error);
    }
  },

  // POST /api/gymfolio/package-orders/summary  { userIds: [...] }  (at most 500)
  summary: async (req, res) => {
    try {
      await sweepIfDue();
      const data = await lists.summaryFor((req.body || {}).userIds);
      return res.json({ success: true, data });
    } catch (error) {
      return fail(res, error);
    }
  }
};
