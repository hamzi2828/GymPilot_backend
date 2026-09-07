// src/services/campaignService.js
//
// Who a campaign goes to, and sending it a batch at a time.
//
// Batches, because the API runs as serverless functions with a time limit:
// a gym with two thousand members cannot be emailed in one request. The
// panel calls send() until it answers done; each call skips everyone who
// already has a log row for this campaign, so a retry after a timeout never
// writes to the same person twice.

const User = require('../models/user');
const PackageOrder = require('../gymfolio/models/packageOrderModel');
const Newsletter = require('../models/newsletterModel');
const MessageLog = require('../models/messageLogModel');
const { sendEmail } = require('./emailService');
const { shell, escapeHtml } = require('../templates/gymEmails');
const templates = require('./templateService');
const messaging = require('./messaging');
const notify = require('./gymNotifications');

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
    const url = `${b.accountUrl.replace(/\/user-detail$/, '')}/unsubscribe?email=${encodeURIComponent(recipient.email)}`;
    return `You are receiving this because you subscribed to ${escapeHtml(b.siteName)} updates. <a href="${escapeHtml(url)}" style="color:#a1a1aa">Unsubscribe</a>`;
  }
  return `You are receiving this because you are a member of ${escapeHtml(b.siteName)}. <a href="${escapeHtml(b.accountUrl)}" style="color:#a1a1aa">Manage what we send you</a>`;
}

/**
 * Sends the next batch. Returns { done, remaining, sent, failed, skipped }.
 */
async function sendBatch(campaign, { limit = 50, actorId = null } = {}) {
  const b = await notify.brand();
  const channel = campaign.channel || 'email';
  const recipients = await resolveAudience(campaign.audience);
  const already = new Set(await MessageLog.distinct('to', { campaignId: campaign._id }));
  const pending = recipients.filter((r) => {
    const address = addressFor(r, channel);
    return !address || !already.has(address);
  });
  const batch = pending.slice(0, limit);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const recipient of batch) {
    const address = addressFor(recipient, channel);
    const vars = campaignVars(recipient, b);
    const meta = { context: 'campaign', campaignId: campaign._id, userId: recipient.userId || null, sentBy: actorId };

    if (!address) {
      skipped += 1;
      // Logged under a synthetic address so the row is visible but never
      // matched as "already sent".
      MessageLog.record({ channel, to: '', userId: recipient.userId || null, subject: campaign.subject, body: campaign.body, context: 'campaign', campaignId: campaign._id, status: 'skipped', error: `no ${channel === 'email' ? 'email address' : channel === 'push' ? 'account' : 'phone number'}` });
      continue;
    }

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
