// src/platform/billingNotices.js
//
// Which lifecycle email a gym's owner is owed today, decided from the
// subscription alone -- no database, no clock but the one passed in -- so
// it can be tested as a plain function and read as a plain rule:
//
//   trialing, ends in <= 7 days  -> trial7      (once)
//   trialing, ends in <= 3 days  -> trial3      (once)
//   trialing, ends in <= 1 day   -> trial1      (once)
//   past_due                     -> pastDue     (once)
//   expired                      -> expired     (once)
//
// "Once" is kept in subscription.notices, which the webhook and the panel
// clear whenever a new period starts. When the cron has missed a few days
// and more than one trial notice is due at once, only the most urgent is
// sent and the others are marked as done -- three emails in one morning
// would say the opposite of "we thought about this".

const DAY_MS = 86400000;

const TRIAL_STEPS = [
  { key: 'trial1', within: 1 },
  { key: 'trial3', within: 3 },
  { key: 'trial7', within: 7 }
];

function daysLeft(currentPeriodEnd, now) {
  if (!currentPeriodEnd) return null;
  const end = new Date(currentPeriodEnd).getTime();
  if (Number.isNaN(end)) return null;
  return Math.ceil((end - now.getTime()) / DAY_MS);
}

/**
 * @param {object} subscription   gym.subscription
 * @param {Date}   [now]
 * @returns {{ send: string|null, mark: string[], daysLeft: number|null }}
 *   `send` is the notice to email now; `mark` every notice to stamp as done
 *   (always includes `send`).
 */
function noticesDue(subscription, now = new Date()) {
  const sub = subscription || {};
  const done = sub.notices || {};
  const left = daysLeft(sub.currentPeriodEnd, now);
  const nothing = { send: null, mark: [], daysLeft: left };

  if (sub.status === 'trialing') {
    if (left === null) return nothing;
    // Most urgent first; anything less urgent that is also due is marked.
    const due = TRIAL_STEPS.filter((step) => left <= step.within && !done[step.key]);
    if (!due.length) return nothing;
    // A trial already over is the roll-over's business, not a reminder's.
    if (left < 0) return { send: null, mark: due.map((s) => s.key), daysLeft: left };
    return { send: due[0].key, mark: due.map((s) => s.key), daysLeft: left };
  }
  if (sub.status === 'past_due') {
    return done.pastDue ? nothing : { send: 'pastDue', mark: ['pastDue'], daysLeft: left };
  }
  if (sub.status === 'expired') {
    return done.expired ? nothing : { send: 'expired', mark: ['expired'], daysLeft: left };
  }
  return nothing;
}

module.exports = { noticesDue, daysLeft, TRIAL_STEPS };
