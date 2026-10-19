// src/services/billing/billingMessages.js
//
// Sends one renewal-billing message -- the payment link before the due
// date, on it, after a declined card, on the last day, or by hand from the
// admin panel -- on every channel it may go by:
//
//   * the gym's billing channels (Settings → Payments → billing.sendVia);
//   * of those, the ones the gym has set up: email unless the gym switched
//     its notification email off, SMS / WhatsApp with a provider in
//     Settings → Messaging, push when the member has a device;
//   * of those, the ones the member has not switched off in their
//     notification preferences, and has an address for.
//
// The wording is the gym's own where it has customised the event
// (Settings → Messaging → Templates: payment_due_soon, payment_due_today,
// payment_card_declined, payment_last_day, payment_link), else the
// built-in email (templates/billingEmails.js) and the registry's short
// text. Every message carries the gym's bank / Raast details as the no-fee
// alternative when it has an account on file.
//
// Never throws: each channel's outcome is reported, and the caller decides
// what "sent" means (the job counts a message sent when any channel took it).

const Settings = require('../../models/settings');
const User = require('../../models/user');
const emailService = require('../emailService');
const messaging = require('../messaging');
const templates = require('../templateService');
const T = require('../../attendance/services/timeUtils');
const { currentTenant } = require('../../platform/tenantContext');
const { billingEmail } = require('../../templates/billingEmails');
const { billingSettings } = require('./settings');
const { activeBanks, bankText } = require('./banks');
const { activeProvider, onlineLabel } = require('./provider');
const { issuePayLink } = require('./payLinks');
const { metadataOf } = require('./dueRenewals');

const EVENT_KEYS = {
  before: 'payment_due_soon',
  due: 'payment_due_today',
  declined: 'payment_card_declined',
  last: 'payment_last_day',
  link: 'payment_link'
};

const DEFAULT_NAME = 'GymsPilotPro';

/** The gym's own name: Settings → General, else its platform record. */
function gymName(settings) {
  const name = String((settings && settings.siteName) || '').trim();
  if (name && name !== DEFAULT_NAME) return name;
  const gym = currentTenant();
  return (gym && gym.name) || name || DEFAULT_NAME;
}

/** "5,000" / "49.50": what the member reads, in the order's own amount. */
function amountLabel(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
}

function dayLabel(key) {
  return key && /^\d{4}-\d{2}-\d{2}$/.test(key) ? T.dateLabelForKey(key) : '';
}

function firstNameOf(member, order) {
  if (member && member.firstName) return member.firstName;
  const full = order && order.customerInfo && order.customerInfo.fullName;
  return full ? String(full).split(' ')[0] : '';
}

/** "Visa •••• 4242" for a saved card. */
function cardLabel(method) {
  if (!method) return '';
  return `${method.brand || 'Card'} •••• ${method.last4 || '????'}`;
}

/**
 * Everything a billing message says about an order. `context` may carry
 * what the caller already has (settings, banks, provider, member) so the
 * daily job reads them once per run rather than once per message.
 */
async function messageVars(order, kind, context = {}) {
  const settings = context.settings !== undefined ? context.settings : await Settings.getSettings().catch(() => null);
  const banks = context.banks || (await activeBanks());
  const provider = context.provider !== undefined ? context.provider : await activeProvider();
  const link = context.link || issuePayLink(order);
  const siteName = gymName(settings);
  const dueKey = metadataOf(order, 'dueDate');
  const lastKey = metadataOf(order, 'lastDay');
  const pay = order.payment || {};
  return {
    firstName: firstNameOf(context.member, order),
    siteName,
    packageName: (order.packageDetails && order.packageDetails.name) || 'membership',
    amount: amountLabel(pay.amount),
    currency: String(pay.currency || '').toUpperCase(),
    dueDate: dayLabel(dueKey),
    lastDay: dayLabel(lastKey) || dayLabel(dueKey),
    orderNumber: order.orderNumber || '',
    payUrl: link.url,
    portalUrl: link.url,
    renewUrl: link.url,
    bankText: bankText(banks),
    reason: context.reason || '',
    onlineLabel: onlineLabel(provider),
    autoPayCard: context.autoPayCard || '',
    banks,
    settings,
    kind
  };
}

async function loadMember(order, member) {
  if (member && member.notificationPreferences !== undefined && member.phone !== undefined) return member;
  if (!order.userId) return member || null;
  try {
    return await User.findById(order.userId).select('firstName lastName email phone isActive notificationPreferences').lean();
  } catch {
    return member || null;
  }
}

/** Emails the message, unless the gym's notification email or the member's is off. */
async function sendEmailChannel(to, vars, prefs) {
  if (!to) return { success: false, skipped: 'no email address' };
  if (vars.settings && vars.settings.emailNotifications === false) return { success: false, skipped: 'email notifications are off' };
  if (prefs.email === false) return { success: false, skipped: 'member has email off' };
  try {
    const custom = await templates.renderEmail(EVENT_KEYS[vars.kind], vars);
    const built = custom || billingEmail(vars.kind, vars);
    const result = await emailService.sendEmail(to, built.subject, built.html);
    if (!result || !result.success) console.error(`[billing] ${vars.kind} email -> ${to} failed:`, result && result.error);
    return result || { success: false, error: 'no answer from the mail sender' };
  } catch (error) {
    console.error(`[billing] ${vars.kind} email -> ${to} threw:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Sends one billing message for an order.
 *
 * @param {object} order   a package order (document or lean)
 * @param {string} kind    before | due | declined | last | link
 * @param {object} context billing, settings, banks, provider, member,
 *                         reason (declined), autoPayCard, link, sentBy
 * @returns {Promise<{ any: boolean, sent: {email, sms, whatsapp, push}, skipped: object }>}
 */
async function sendBillingMessage(order, kind, context = {}) {
  const sent = { email: false, sms: false, whatsapp: false, push: false };
  const skipped = {};
  try {
    const member = await loadMember(order, context.member);
    const vars = await messageVars(order, kind, { ...context, member });
    const billing = context.billing || billingSettings(vars.settings);
    const via = billing.sendVia;
    const prefs = (member && member.notificationPreferences) || {};
    const phone = (member && member.phone) || (order.customerInfo && order.customerInfo.phone) || '';
    const email = (member && member.email) || (order.customerInfo && order.customerInfo.email) || '';
    const meta = { context: `billing ${kind}`, userId: member ? member._id : order.userId || null, sentBy: context.sentBy || null };

    const jobs = [];
    if (via.email) {
      jobs.push(sendEmailChannel(email, vars, prefs).then((r) => ['email', r]));
    } else skipped.email = 'off for billing';

    const needsText = via.sms || via.whatsapp || via.push;
    const text = needsText ? await templates.renderText(EVENT_KEYS[kind], vars) : '';
    for (const channel of ['sms', 'whatsapp']) {
      if (!via[channel]) skipped[channel] = 'off for billing';
      else if (prefs[channel] === false) skipped[channel] = `member has ${channel} off`;
      else if (!phone) skipped[channel] = 'no phone number';
      else {
        const send = channel === 'sms' ? messaging.sendSms : messaging.sendWhatsApp;
        jobs.push(send(phone, text, meta).then((r) => [channel, r]));
      }
    }
    if (!via.push) skipped.push = 'off for billing';
    else if (prefs.push === false) skipped.push = 'member has push off';
    else if (!meta.userId) skipped.push = 'no member account';
    else jobs.push(messaging.sendPush(meta.userId, { title: vars.siteName, body: text, url: vars.payUrl }, { context: meta.context, sentBy: meta.sentBy }).then((r) => ['push', r]));

    for (const outcome of await Promise.allSettled(jobs)) {
      if (outcome.status !== 'fulfilled') continue;
      const [channel, result] = outcome.value;
      if (result && result.success) sent[channel] = true;
      else skipped[channel] = (result && (result.skipped || result.error)) || 'not sent';
    }
  } catch (error) {
    console.error(`[billing] ${kind} message for ${order && order.orderNumber} failed:`, error.message);
    skipped.error = error.message;
  }
  return { any: Object.values(sent).some(Boolean), sent, skipped };
}

module.exports = { EVENT_KEYS, sendBillingMessage, messageVars, gymName, amountLabel, cardLabel };
