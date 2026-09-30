// src/gymfolio/controller/feeDeskController.js
//
// The fee desk's reads (services/feeDesk.js): find a member, then see what
// they hold, what a renewal costs and what they owe. Staff only
// (package-orders · view on the routes); taking the money goes through the
// renew, payments and assign routes, which need manage. Both sweep lapsed
// orders first (throttled), like the desk's lists, so a status read here is
// today's.

const feeDesk = require('../services/feeDesk');
const { MembershipError } = require('../services/membershipService');
const { sweepIfDue } = require('../services/membershipExpiry');

function fail(res, error) {
  if (error instanceof MembershipError) {
    return res.status(error.status || 400).json({ success: false, message: error.message, code: error.code || undefined });
  }
  console.error('[fee desk]', error);
  return res.status(500).json({ success: false, message: 'Could not load the member' });
}

module.exports = {
  // GET /api/gymfolio/package-orders/desk/members?q=&limit=
  search: async (req, res) => {
    try {
      await sweepIfDue();
      const q = req.query || {};
      const { rows, hasMore } = await feeDesk.searchMembers(q.q, { limit: q.limit });
      return res.json({ success: true, data: rows, hasMore });
    } catch (error) {
      return fail(res, error);
    }
  },

  // GET /api/gymfolio/package-orders/desk/members/:userId
  member: async (req, res) => {
    try {
      await sweepIfDue();
      const data = await feeDesk.deskView(req.params.userId);
      return res.json({ success: true, data });
    } catch (error) {
      return fail(res, error);
    }
  }
};
