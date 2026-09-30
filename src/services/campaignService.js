// src/services/campaignService.js
//
// Who a campaign goes to, and sending it a batch at a time.
//
// Batches, because the API runs as serverless functions with a time limit:
// a gym with two thousand members cannot be emailed in one request. The
// panel calls send() until it answers done; each call skips everyone this
// campaign has already reached, so a resumed send never writes to the same
// person twice.
//
// Failures are the exception, deliberately. Within one pass a failed address
// is not tried again (a dead mailbox would otherwise be retried until the
// pass never ends), but a failure from an EARLIER pass is exactly what a
// retry exists to reach. The pass boundary is `since` -- the campaign's
// startedAt, reset by the controller when a retry begins.

const User = require('../models/user');
const PackageOrder = require('../gymfolio/models/packageOrderModel');
const Newsletter = require('../models/newsletterModel');
const MessageLog = require('../models/messageLogModel');
const { sendEmail } = require('./emailService');
const { shell, escapeHtml } = require('../templates/gymEmails');
const templates = require('./templateService');
const messaging = require('./messaging');
const notify = require('./gymNotifications');
const { unsubscribeUrl } = require('./unsubscribeLinks');

const DAY_MS = 24 * 60 * 60 * 1000;
const MEMBER_FIELDS = 'firstName lastName email phone notificationPreferences tags';

function memberRecipient(u) {
  return { userId: u._id, email: u.email || '', phone: u.phone || '', firstName: u.firstName || '', lastName: u.lastName || '', kind: 'member' };
}

/**
 * The people a campaign's audience describes. Members who have opted out of
 * marketing are left out here, so no channel has to remember to check.
 */
async function resolveAudience(audience = {}) {
  const type = audience.type || 'all_members';
  const now = new Date();
  const memberBase = { role: 'user', isActive: { $ne: false } };

  if (type === 'newsletter') {
    const subs = await Newsletter.find({ status: 'active' }).select('email').lean();
    return subs.map((s) => ({ userId: null, email: s.email, phone: '', firstName: '', lastName: '', kind: 'newsletter' }));
  }

  if (type === 'leads') {
    try {
      const Lead = require('../models/leadModel');
      const leads = await Lead.find({ status: { $nin: ['won', 'lost'] }, isActive: { $ne: false } })
        .select('firstName lastName email phone')
        .lean();
      return leads.map((l) => ({ userId: null, leadId: l._id, email: l.email || '', phone: l.phone || '', firstName: l.firstName || '', lastName: l.lastName || '', kind: 'lead' }));
    } catch {
      return [];
    }
  }

  let filter = { ...memberBase };
  if (type === 'tags') {
    const tags = (audience.tags || []).map((t) => String(t).trim()).filter(Boolean);
    if (!tags.length) return [];
    filter.tags = { $in: tags };
  } else if (type === 'active_members' || type === 'expiring_members' || type === 'expired_members') {
    const live = {
      'payment.status': 'paid',
      status: { $in: ['active', 'frozen', 'past_due'] },
      'subscription.endDate': { $gte: now }
    };
    if (type === 'expiring_members') {
      const days = Math.max(1, parseInt(audience.days, 10) || 14);
      live['subscription.endDate'] = { $gte: now, $lte: new Date(now.getTime() + days * DAY_MS) };
    }
    const liveIds = (await PackageOrder.distinct('userId', live)).filter(Boolean);
    if (type === 'expired_members') {
      const everIds = (await PackageOrder.distinct('userId', { 'payment.status': 'paid' })).filter(Boolean);
      const liveSet = new Set(liveIds.map(String));
      filter._id = { $in: everIds.filter((id) => !liveSet.has(String(id))) };
    } else {
      filter._id = { $in: liveIds };
    }
  }

  const users = await User.find(filter).select(MEMBER_FIELDS).lean();
  return users.filter((u) => !(u.notificationPreferences && u.notificationPreferences.marketing === false)).map(memberRecipient);
}

function addressFor(recipient, channel) {
  if (channel === 'email') return recipient.email;
  if (channel === 'push') return recipient.userId ? String(recipient.userId) : '';
  return recipient.phone;
}

function campaignVars(recipient, b) {
  return {
    firstName: recipient.firstName || 'there',
    siteName: b.siteName,
    portalUrl: b.accountUrl,
    timetableUrl: b.timetableUrl,
    renewUrl: b.renewUrl
  };
}

function footerFor(recipient, b) {
  if (recipient.kind === 'newsletter') {
    // Signed for this address at this gym: the page will not unsubscribe
    // anyone on an address alone (services/unsubscribeLinks.js).
    const url = unsubscribeUrl(b.accountUrl.replace(/\/user-detail$/, ''), recipient.email);
    return `You are receiving this because you subscribed to ${escapeHtml(b.siteName)} updates. <a href="${escapeHtml(url)}" style="color:#a1a1aa">Unsubscribe</a>`;
  }
  return `You are receiving this because you are a member of ${escapeHtml(b.siteName)}. <a href="${escapeHtml(b.accountUrl)}" style="color:#a1a1aa">Manage what we send you</a>`;
}

/**
 * Sends the next batch. Returns { done, remaining, sent, failed, skipped }.
 */
async function sendBatch(campaign, { limit = 50, actorId = null, since = null } = {}) {
  const b = await notify.brand();
  const channel = campaign.channel || 'email';
  const recipients = await resolveAudience(campaign.audience);

  // Done: everyone reached, plus everyone this pass already tried and could
  // not reach. Failures from before the pass started are retried.
  const passStart = since ? new Date(since) : campaign.startedAt ? new Date(campaign.startedAt) : null;
  const failedFilter = { campaignId: campaign._id, status: 'failed' };
  if (passStart && !Number.isNaN(passStart.getTime())) failedFilter.createdAt = { $gte: passStart };
  const [reached, failedThisPass] = await Promise.all([
    MessageLog.distinct('to', { campaignId: campaign._id, status: 'sent' }),
    MessageLog.distinct('to', failedFilter)
  ]);
  const already = new Set([...reached, ...failedThisPass]);

  // Nobody without an address on this channel is pending: they can never be
  // reached, and while they stayed in the queue a batch made only of them
  // came round again on every call -- fifty members with no email at the
  // front of the list, and nobody behind them was ever sent the campaign.
  const unreachable = [];
  const pending = [];
  for (const recipient of recipients) {
    const address = addressFor(recipient, channel);
    if (!address) unreachable.push(recipient);
    else if (!already.has(address)) pending.push(recipient);
  }
  const batch = pending.slice(0, limit);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  // They are counted as skipped and logged once, by the campaign's first
  // batch: the counts are added up call by call, and a retry pass is the
  // same people. Logged under a synthetic address so the rows are visible
  // but never matched as "already sent" -- in one write, as there can be
  // thousands, and (like MessageLog.record) never failing the send.
  if (unreachable.length && !(await MessageLog.exists({ campaignId: campaign._id, status: 'skipped' }))) {
    skipped = unreachable.length;
    const error = `no ${channel === 'email' ? 'email address' : channel === 'push' ? 'account' : 'phone number'}`;
    const body = String(campaign.body || '').slice(0, 500);
    await MessageLog.insertMany(
      unreachable.map((recipient) => ({ channel, to: '', userId: recipient.userId || null, subject: campaign.subject, body, context: 'campaign', campaignId: campaign._id, status: 'skipped', error })),
      { ordered: false }
    ).catch((err) => console.error('[campaigns] could not log the skipped recipients:', err.message));
  }

  for (const recipient of batch) {
    const address = addressFor(recipient, channel);
    const vars = campaignVars(recipient, b);
    const meta = { context: 'campaign', campaignId: campaign._id, userId: recipient.userId || null, sentBy: actorId };

    let result;
    if (channel === 'email') {
      const subject = templates.fill(campaign.subject, vars, false);
      const html = shell(b.siteName, subject, templates.bodyToHtml(campaign.body, vars), footerFor(recipient, b));
      result = await sendEmail(address, subject, html);
      MessageLog.record({ ...meta, channel, to: address, subject, body: campaign.body, status: result.success ? 'sent' : 'failed', error: result.success ? '' : result.error, provider: 'smtp' });
    } else if (channel === 'push') {
      result = await messaging.sendPush(recipient.userId, { title: templates.fill(campaign.subject || b.siteName, vars, false), body: templates.fill(campaign.body, vars, false), url: campaign.url || b.accountUrl }, meta);
    } else {
      result = await messaging.sendText(channel, address, templates.fill(campaign.body, vars, false), meta);
    }

    if (result && result.success) sent += 1;
    else failed += 1;
  }

  const remaining = pending.length - batch.length;
  return { done: remaining <= 0, remaining, targeted: recipients.length, sent, failed, skipped };
}

module.exports = { resolveAudience, sendBatch, addressFor };
