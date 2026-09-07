// src/services/messaging.js
//
// The channels beside email: SMS and WhatsApp through whichever provider the
// gym has put in Settings → Messaging, and web push to the browsers members
// have allowed.
//
// Providers are deliberately thin and talk plain HTTP -- no SDKs -- so a gym
// in Lahore on a local SMS gateway and a gym in London on Twilio are the
// same code with different settings. The "http" provider is the escape
// hatch: POST {channel, to, body} to any URL, which is how a gateway this
// file has never heard of gets plugged in.
//
// Every send is logged (models/messageLogModel.js) and nothing here throws:
// a message that fails is a log row, never a broken booking.

const webpush = require('web-push');
const Settings = require('../models/settings');
const MessageLog = require('../models/messageLogModel');
const PushSubscription = require('../models/pushSubscriptionModel');

const TWILIO_API = 'https://api.twilio.com/2010-04-01';
const META_API = 'https://graph.facebook.com/v20.0';
const REQUEST_TIMEOUT_MS = 15000;

async function messagingConfig() {
  try {
    const settings = await Settings.getSettings();
    return (settings && settings.messaging) || {};
  } catch {
    return {};
  }
}

/**
 * E.164-ish: "+92 300 1234567" -> "+923001234567". A number with no country
 * code and a leading zero gets the gym's default code, so members who typed
 * their local number are still reachable.
 */
function normalizePhone(raw, defaultCountryCode = '') {
  let value = String(raw || '').trim().replace(/^whatsapp:/i, '');
  if (!value) return '';
  const international = value.startsWith('+') || value.startsWith('00');
  const digits = value.replace(/\D/g, '').replace(/^00/, '');
  if (!digits) return '';
  if (international) return `+${digits}`;
  const code = String(defaultCountryCode || '').replace(/\D/g, '');
  if (code && digits.startsWith('0')) return `+${code}${digits.slice(1)}`;
  if (code && !digits.startsWith(code)) return `+${code}${digits}`;
  return code ? `+${digits}` : digits;
}

function providerFor(cfg, channel) {
  const c = (cfg && cfg[channel]) || {};
  const provider = c.provider || 'none';
  if (provider === 'twilio' && c.accountSid && c.authToken && c.from) return { name: 'twilio', ...c };
  if (provider === 'meta' && channel === 'whatsapp' && c.phoneNumberId && c.accessToken) return { name: 'meta', ...c };
  if (provider === 'http' && c.webhookUrl) return { name: 'http', ...c };
  return null;
}

function pushConfig(cfg) {
  const p = (cfg && cfg.push) || {};
  return p.enabled && p.vapidPublicKey && p.vapidPrivateKey ? p : null;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function twilioSend(p, channel, to, body) {
  const prefix = channel === 'whatsapp' ? 'whatsapp:' : '';
  const from = !prefix || p.from.startsWith('whatsapp:') ? p.from : `${prefix}${p.from}`;
  const params = new URLSearchParams({ To: `${prefix}${to}`, From: from, Body: body });
  const res = await fetch(`${TWILIO_API}/Accounts/${encodeURIComponent(p.accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${p.accountSid}:${p.authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error(json.message || `Twilio answered ${res.status}`);
  return json.sid || '';
}

async function metaSend(p, to, body) {
  const res = await fetch(`${META_API}/${encodeURIComponent(p.phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to.replace(/^\+/, ''),
      type: 'text',
      text: { preview_url: false, body }
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error((json.error && json.error.message) || `WhatsApp API answered ${res.status}`);
  return (json.messages && json.messages[0] && json.messages[0].id) || '';
}

async function httpSend(p, channel, to, body) {
  const res = await fetch(p.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(p.webhookToken ? { Authorization: `Bearer ${p.webhookToken}` } : {})
    },
    body: JSON.stringify({ channel, to, body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const json = await readJson(res);
  if (!res.ok) throw new Error(json.message || json.error || `Gateway answered ${res.status}`);
  return String(json.id || json.messageId || json.sid || '');
}

/**
 * Sends one text on one channel. Resolves to { success, error?, skipped? };
 * never rejects.
 *
 * @param {'sms'|'whatsapp'} channel
 * @param {object} meta  { context, userId, campaignId, sentBy }
 */
async function sendText(channel, rawTo, body, meta = {}) {
  const cfg = await messagingConfig();
  const provider = providerFor(cfg, channel);
  const entry = {
    channel,
    to: '',
    userId: meta.userId || null,
    body,
    context: meta.context || '',
    campaignId: meta.campaignId || null,
    sentBy: meta.sentBy || null,
    provider: provider ? provider.name : ''
  };

  if (!provider) {
    // Not an error worth a log row on every booking: the gym simply has not
    // switched this channel on. Campaigns and manual sends check first.
    return { success: false, skipped: `${channel} is not set up` };
  }

  const to = normalizePhone(rawTo, cfg.defaultCountryCode);
  entry.to = to;
  if (!to) {
    MessageLog.record({ ...entry, status: 'skipped', error: 'no phone number' });
    return { success: false, skipped: 'no phone number' };
  }
  if (!String(body || '').trim()) {
    return { success: false, skipped: 'empty message' };
  }

  try {
    const providerId =
      provider.name === 'twilio'
        ? await twilioSend(provider, channel, to, body)
        : provider.name === 'meta'
        ? await metaSend(provider, to, body)
        : await httpSend(provider, channel, to, body);
    MessageLog.record({ ...entry, status: 'sent', providerId });
    return { success: true, providerId };
  } catch (error) {
    MessageLog.record({ ...entry, status: 'failed', error: error.message });
    console.error(`[messages] ${channel} -> ${to} failed:`, error.message);
    return { success: false, error: error.message };
  }
}

const sendSms = (to, body, meta) => sendText('sms', to, body, meta);
const sendWhatsApp = (to, body, meta) => sendText('whatsapp', to, body, meta);

/**
 * Pushes to every browser a member has registered. Subscriptions the
 * browser has revoked are dropped as they are discovered.
 */
async function sendPush(userId, payload, meta = {}) {
  const cfg = await messagingConfig();
  const p = pushConfig(cfg);
  if (!p) return { success: false, skipped: 'push is not set up' };

  const subs = await PushSubscription.find({ userId }).lean();
  if (!subs.length) return { success: false, skipped: 'no devices' };

  const vapidDetails = {
    subject: p.subject || 'mailto:no-reply@gympilot.app',
    publicKey: p.vapidPublicKey,
    privateKey: p.vapidPrivateKey
  };
  const data = JSON.stringify({
    title: payload.title || '',
    body: payload.body || '',
    url: payload.url || '/',
    icon: payload.icon || '/images/logo.png'
  });

  let sent = 0;
  let failed = 0;
  let lastError = '';
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, data, { vapidDetails, TTL: 24 * 60 * 60 });
      sent += 1;
    } catch (error) {
      failed += 1;
      lastError = error.message || String(error);
      if (error.statusCode === 404 || error.statusCode === 410) {
        await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
      }
    }
  }
  if (sent) PushSubscription.updateMany({ userId }, { $set: { lastUsedAt: new Date() } }).catch(() => {});

  MessageLog.record({
    channel: 'push',
    to: String(userId),
    userId,
    subject: payload.title || '',
    body: payload.body || '',
    context: meta.context || '',
    campaignId: meta.campaignId || null,
    sentBy: meta.sentBy || null,
    provider: 'webpush',
    status: sent ? 'sent' : 'failed',
    error: sent ? '' : lastError
  });
  return { success: sent > 0, sent, failed, error: sent ? null : lastError };
}

function generateVapidKeys() {
  return webpush.generateVAPIDKeys();
}

/** Which channels this gym can actually send on right now. */
async function channels() {
  const cfg = await messagingConfig();
  return {
    email: true,
    sms: !!providerFor(cfg, 'sms'),
    whatsapp: !!providerFor(cfg, 'whatsapp'),
    push: !!pushConfig(cfg)
  };
}

module.exports = {
  normalizePhone,
  messagingConfig,
  sendSms,
  sendWhatsApp,
  sendText,
  sendPush,
  generateVapidKeys,
  channels
};
