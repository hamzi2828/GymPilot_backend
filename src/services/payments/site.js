// src/services/payments/site.js
//
// The gym website a payment gateway sends the member back to (checkout
// success and cancel pages, the pay link page): the gym's PRIMARY domain on
// its platform record, https unless it is a local address -- the address
// the platform's own emails link to (tenantContext.siteUrlFor). Never
// Settings → siteUrl, which a gym may have left stale, and never anything
// from the request: whatever address a request came in on, the member
// lands on the gym's real site.

const { currentTenant, siteUrlFor } = require('../../platform/tenantContext');

/** e.g. 'https://demo.gymspilotpro.com' -- no trailing slash; '' when the gym has no address. */
function gymSiteOrigin() {
  return String(siteUrlFor(currentTenant()) || '').replace(/\/+$/, '');
}

module.exports = { gymSiteOrigin };
