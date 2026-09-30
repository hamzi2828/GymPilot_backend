// src/gymfolio/controller/membershipListsController.js
//
// The front desk's member lists, built on services/membershipLists.js:
// who owes money. Staff only (package-orders · view on the routes).

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
  }
};
