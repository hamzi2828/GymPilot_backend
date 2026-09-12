// src/controller/messagingController.js
//
// The admin Messaging screen and the member-side notification settings:
// which channels work, what has been sent, the gym's own wording for each
// message, campaigns, announcements, push subscriptions and the automated
// nudges' switches.

const mongoose = require('mongoose');
const User = require('../models/user');
const MessageLog = require('../models/messageLogModel');
const MessageTemplate = require('../models/messageTemplateModel');
const Campaign = require('../models/campaignModel');
const Announcement = require('../models/announcementModel');
const PushSubscription = require('../models/pushSubscriptionModel');
const Settings = require('../models/settings');
const messaging = require('../services/messaging');
const templates = require('../services/templateService');
const campaigns = require('../services/campaignService');
const notify = require('../services/gymNotifications');
const { sendEmail } = require('../services/emailService');
const { shell } = require('../templates/gymEmails');
const { automationSettings, runAutomations } = require('../services/automations');
const T = require('../attendance/services/timeUtils');

const isId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const actorId = (req) => req.user && (req.user.id || req.user._id);

function fail(res, code, message) {
  return res.status(code).json({ success: false, message });
}

function campaignView(c) {
  return {
    id: String(c._id),
    title: c.title,
    channel: c.channel,
    audience: c.audience || { type: 'all_members', tags: [], days: 14 },
    subject: c.subject || '',
    body: c.body || '',
    url: c.url || '',
    status: c.status,
    stats: c.stats || { targeted: 0, sent: 0, failed: 0, skipped: 0 },
    started_at: c.startedAt,
    sent_at: c.sentAt,
    created_at: c.createdAt,
    updated_at: c.updatedAt
  };
}

function announcementView(a) {
  return {
    id: String(a._id),
    title: a.title,
    body: a.body || '',
    audience: a.audience,
    tone: a.tone,
    url: a.url || '',
    url_label: a.urlLabel || '',
    starts_at: a.startsAt,
    ends_at: a.endsAt,
    is_active: a.isActive !== false,
    created_at: a.createdAt
  };
}

function readAudience(input = {}) {
  const type = Campaign.AUDIENCES.includes(input.type) ? input.type : 'all_members';
  return {
    type,
    tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 50) : [],
    days: Math.max(1, parseInt(input.days, 10) || 14)
  };
}

// `edge` says which end of the day a bare 'YYYY-MM-DD' means: an announcement
// that "ends 30 Sep" must still be up at 23:59 on the 30th at the gym, and
// one that "starts 1 Oct" goes up at the gym's midnight, whatever zone the
// server runs in. A full timestamp is taken as it is.
function readDate(value, edge = 'start') {
  if (value === undefined || value === null || value === '') return null;
  if (T.isDateOnly(value)) {
    const key = String(value).trim();
    return edge === 'end' ? T.lastMomentOfLocalDay(key) : T.startOfLocalDay(key);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = {
  // GET /admin/messaging/channels
  channels: async (req, res) => {
    try {
      const [available, settings] = await Promise.all([messaging.channels(), Settings.getSettings()]);
      const m = (settings && settings.messaging) || {};
      const [subscriptions, automations] = await Promise.all([PushSubscription.countDocuments({}), automationSettings()]);
      return res.json({
        success: true,
        data: {
          available,
          providers: { sms: (m.sms && m.sms.provider) || 'none', whatsapp: (m.whatsapp && m.whatsapp.provider) || 'none' },
          transactional: { sms: !!(m.transactional && m.transactional.sms), whatsapp: !!(m.transactional && m.transactional.whatsapp), push: !(m.transactional && m.transactional.push === false) },
          push_devices: subscriptions,
          automations
        }
      });
    } catch (error) {
      console.error('[messaging] channels failed:', error);
      return fail(res, 500, 'Could not read the messaging setup');
    }
  },

  // GET /admin/messaging/log?channel=&status=&limit=
  log: async (req, res) => {
    try {
      const filter = {};
      if (['email', 'sms', 'whatsapp', 'push'].includes(req.query.channel)) filter.channel = req.query.channel;
      if (['sent', 'failed', 'skipped'].includes(req.query.status)) filter.status = req.query.status;
      if (req.query.campaignId && isId(req.query.campaignId)) filter.campaignId = req.query.campaignId;
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const rows = await MessageLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
      return res.json({
        success: true,
        data: rows.map((r) => ({
          id: String(r._id),
          channel: r.channel,
          to: r.to,
          user_id: r.userId ? String(r.userId) : null,
          subject: r.subject || '',
          body: r.body || '',
          context: r.context || '',
          campaign_id: r.campaignId ? String(r.campaignId) : null,
          status: r.status,
          error: r.error || '',
          provider: r.provider || '',
          created_at: r.createdAt
        }))
      });
    } catch (error) {
      console.error('[messaging] log failed:', error);
      return fail(res, 500, 'Could not load the message log');
    }
  },

  // POST /admin/messaging/send   { userId, channel, subject?, body }
  send: async (req, res) => {
    try {
      const { userId, channel, subject, body } = req.body || {};
      if (!isId(userId)) return fail(res, 400, 'A valid userId is required');
      if (!['email', 'sms', 'whatsapp', 'push'].includes(channel)) return fail(res, 400, 'channel must be email, sms, whatsapp or push');
      if (!String(body || '').trim()) return fail(res, 400, 'A message is required');

      const member = await User.findById(userId).select('firstName lastName email phone notificationPreferences').lean();
      if (!member) return fail(res, 404, 'Member not found');

      const b = await notify.brand();
      const vars = { firstName: member.firstName || 'there', siteName: b.siteName, portalUrl: b.accountUrl, timetableUrl: b.timetableUrl, renewUrl: b.renewUrl };
      const text = templates.fill(body, vars, false);
      const meta = { context: 'manual', userId: member._id, sentBy: actorId(req) };

      let result;
      if (channel === 'email') {
        if (!member.email) return fail(res, 409, 'This member has no email address');
        const subj = templates.fill(subject || `A message from ${b.siteName}`, vars, false);
        result = await sendEmail(member.email, subj, shell(b.siteName, subj, templates.bodyToHtml(body, vars)));
        MessageLog.record({ ...meta, channel, to: member.email, subject: subj, body: text, status: result.success ? 'sent' : 'failed', error: result.success ? '' : result.error, provider: 'smtp' });
      } else if (channel === 'push') {
        result = await messaging.sendPush(member._id, { title: templates.fill(subject || b.siteName, vars, false), body: text, url: b.accountUrl }, meta);
      } else {
        if (!member.phone) return fail(res, 409, 'This member has no phone number');
        result = await messaging.sendText(channel, member.phone, text, meta);
      }

      if (!result || !result.success) {
        return res.status(502).json({ success: false, message: (result && (result.error || result.skipped)) || 'Send failed' });
      }
      return res.json({ success: true, message: `Sent by ${channel}.` });
    } catch (error) {
      console.error('[messaging] send failed:', error);
      return fail(res, 500, 'Could not send the message');
    }
  },

  // ---- templates ----------------------------------------------------------

  // GET /admin/messaging/templates
  listTemplates: async (req, res) => {
    try {
      const [rows, b] = await Promise.all([templates.list(), notify.brand()]);
      return res.json({ success: true, data: rows, sample: templates.sampleVars(b.siteName, b.accountUrl.replace(/\/user-detail$/, '')) });
    } catch (error) {
      console.error('[messaging] templates failed:', error);
      return fail(res, 500, 'Could not load the templates');
    }
  },

  // PUT /admin/messaging/templates/:key   { subject, body, text, enabled }
  saveTemplate: async (req, res) => {
    try {
      const { key } = req.params;
      if (!templates.isEvent(key)) return fail(res, 404, 'Unknown message');
      const { subject, body, text, enabled } = req.body || {};
      const doc = await MessageTemplate.findOneAndUpdate(
        { key },
        {
          $set: {
            subject: String(subject || '').trim().slice(0, 200),
            body: String(body || '').slice(0, 20000),
            text: String(text || '').trim().slice(0, 1000),
            enabled: enabled === undefined ? true : enabled === true || enabled === 'true',
            updatedBy: actorId(req)
          }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).lean();
      return res.json({ success: true, message: 'Wording saved.', data: { key, subject: doc.subject, body: doc.body, text: doc.text, enabled: doc.enabled } });
    } catch (error) {
      console.error('[messaging] save template failed:', error);
      return fail(res, 500, 'Could not save the wording');
    }
  },

  // DELETE /admin/messaging/templates/:key   -> back to the built-in text
  resetTemplate: async (req, res) => {
    try {
      const { key } = req.params;
      if (!templates.isEvent(key)) return fail(res, 404, 'Unknown message');
      await MessageTemplate.deleteOne({ key });
      return res.json({ success: true, message: 'Back to the built-in wording.' });
    } catch (error) {
      console.error('[messaging] reset template failed:', error);
      return fail(res, 500, 'Could not reset the wording');
    }
  },

  // POST /admin/messaging/templates/:key/test   -> emails the caller a sample
  testTemplate: async (req, res) => {
    try {
      const { key } = req.params;
      if (!templates.isEvent(key)) return fail(res, 404, 'Unknown message');
      const me = await User.findById(actorId(req)).select('email firstName').lean();
      if (!me || !me.email) return fail(res, 409, 'Your account has no email address');
      const b = await notify.brand();
      const vars = { ...templates.sampleVars(b.siteName, b.accountUrl.replace(/\/user-detail$/, '')), firstName: me.firstName || 'there' };
      const built = await templates.renderEmail(key, vars);
      if (!built) return fail(res, 409, 'This message uses the built-in email. Save your own wording first to preview it.');
      const result = await sendEmail(me.email, `[Test] ${built.subject}`, built.html);
      if (!result.success) return res.status(502).json({ success: false, message: `Could not send: ${result.error}` });
      return res.json({ success: true, message: `Sent a sample to ${me.email}.`, text: await templates.renderText(key, vars) });
    } catch (error) {
      console.error('[messaging] test template failed:', error);
      return fail(res, 500, 'Could not send the sample');
    }
  },

  // ---- campaigns ----------------------------------------------------------

  // GET /admin/messaging/campaigns
  listCampaigns: async (req, res) => {
    try {
      const rows = await Campaign.find({}).sort({ createdAt: -1 }).limit(200).lean();
      return res.json({ success: true, data: rows.map(campaignView) });
    } catch (error) {
      console.error('[messaging] campaigns failed:', error);
      return fail(res, 500, 'Could not load campaigns');
    }
  },

  // POST /admin/messaging/campaigns
  createCampaign: async (req, res) => {
    try {
      const body = req.body || {};
      if (!String(body.title || '').trim()) return fail(res, 400, 'A title is required');
      const channel = Campaign.CHANNELS.includes(body.channel) ? body.channel : 'email';
      const doc = await Campaign.create({
        title: String(body.title).trim(),
        channel,
        audience: readAudience(body.audience),
        subject: String(body.subject || '').trim(),
        body: String(body.body || ''),
        url: String(body.url || '').trim(),
        createdBy: actorId(req),
        updatedBy: actorId(req)
      });
      return res.status(201).json({ success: true, data: campaignView(doc) });
    } catch (error) {
      console.error('[messaging] create campaign failed:', error);
      return fail(res, 500, 'Could not create the campaign');
    }
  },

  // PUT /admin/messaging/campaigns/:id
  updateCampaign: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 400, 'Invalid campaign id');
      const doc = await Campaign.findById(req.params.id);
      if (!doc) return fail(res, 404, 'Campaign not found');
      if (doc.status !== 'draft') return fail(res, 409, 'Only drafts can be edited');
      const body = req.body || {};
      if (body.title !== undefined) doc.title = String(body.title).trim() || doc.title;
      if (body.channel !== undefined && Campaign.CHANNELS.includes(body.channel)) doc.channel = body.channel;
      if (body.audience !== undefined) doc.audience = readAudience(body.audience);
      if (body.subject !== undefined) doc.subject = String(body.subject).trim();
      if (body.body !== undefined) doc.body = String(body.body);
      if (body.url !== undefined) doc.url = String(body.url).trim();
      doc.updatedBy = actorId(req);
      await doc.save();
      return res.json({ success: true, data: campaignView(doc) });
    } catch (error) {
      console.error('[messaging] update campaign failed:', error);
      return fail(res, 500, 'Could not update the campaign');
    }
  },

  // DELETE /admin/messaging/campaigns/:id
  deleteCampaign: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 400, 'Invalid campaign id');
      const doc = await Campaign.findById(req.params.id);
      if (!doc) return fail(res, 404, 'Campaign not found');
      if (doc.status === 'sending') return fail(res, 409, 'This campaign is still sending');
      await Campaign.deleteOne({ _id: doc._id });
      return res.json({ success: true, message: 'Campaign deleted.' });
    } catch (error) {
      console.error('[messaging] delete campaign failed:', error);
      return fail(res, 500, 'Could not delete the campaign');
    }
  },

  // GET /admin/messaging/campaigns/:id/audience   -> how many, and a preview
  campaignAudience: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 400, 'Invalid campaign id');
      const doc = await Campaign.findById(req.params.id).lean();
      if (!doc) return fail(res, 404, 'Campaign not found');
      const recipients = await campaigns.resolveAudience(doc.audience);
      const withAddress = recipients.filter((r) => campaigns.addressFor(r, doc.channel));
      return res.json({
        success: true,
        data: {
          total: recipients.length,
          reachable: withAddress.length,
          preview: withAddress.slice(0, 10).map((r) => ({ name: [r.firstName, r.lastName].filter(Boolean).join(' '), address: campaigns.addressFor(r, doc.channel) }))
        }
      });
    } catch (error) {
      console.error('[messaging] audience failed:', error);
      return fail(res, 500, 'Could not count the audience');
    }
  },

  // POST /admin/messaging/campaigns/:id/send   { limit }
  sendCampaign: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 400, 'Invalid campaign id');
      const doc = await Campaign.findById(req.params.id);
      if (!doc) return fail(res, 404, 'Campaign not found');
      const body = req.body || {};

      // Retry: a campaign that ended 'failed', or one that was 'sent' with
      // failures when the panel asks for { retry: true }. Either way it is a
      // fresh pass over the people the last pass could not reach -- and only
      // them; everyone already reached is left alone.
      const wantsRetry = body.retry === true || body.retry === 'true';
      const retrying = doc.status === 'failed' || (doc.status === 'sent' && wantsRetry && (doc.stats && doc.stats.failed) > 0);
      if (doc.status === 'sent' && !retrying) return fail(res, 409, 'This campaign has already been sent');
      if (doc.channel === 'email' && !String(doc.subject || '').trim()) return fail(res, 400, 'An email campaign needs a subject');
      if (!String(doc.body || '').trim()) return fail(res, 400, 'The message is empty');

      const available = await messaging.channels();
      if (!available[doc.channel]) return fail(res, 409, `${doc.channel} is not set up. Add a provider under Settings → Messaging.`);

      if (doc.status === 'draft') {
        doc.status = 'sending';
        doc.startedAt = new Date();
        doc.stats = { targeted: 0, sent: 0, failed: 0, skipped: 0 };
      } else if (retrying) {
        // startedAt marks the start of THIS pass: sendBatch treats failures
        // older than it as retryable and failures newer than it as done, so
        // an address that fails again is not hammered until the pass ends.
        doc.status = 'sending';
        doc.startedAt = new Date();
        doc.stats.failed = 0;
      }
      const limit = Math.min(200, Math.max(1, parseInt(body.limit, 10) || 50));
      const result = await campaigns.sendBatch(doc, { limit, actorId: actorId(req), since: doc.startedAt });

      doc.stats.targeted = result.targeted;
      doc.stats.sent += result.sent;
      doc.stats.failed += result.failed;
      doc.stats.skipped += result.skipped;
      if (result.done) {
        doc.status = doc.stats.sent === 0 && doc.stats.targeted > 0 ? 'failed' : 'sent';
        doc.sentAt = new Date();
      }
      await doc.save();

      return res.json({ success: true, done: result.done, remaining: result.remaining, data: campaignView(doc) });
    } catch (error) {
      console.error('[messaging] send campaign failed:', error);
      return fail(res, 500, 'Could not send the campaign');
    }
  },

  // ---- announcements -------------------------------------------------------

  // GET /announcements/active   (public; more when signed in)
  activeAnnouncements: async (req, res) => {
    try {
      const rows = await Announcement.liveFor(!!(req.user && (req.user.id || req.user._id)));
      return res.json({ success: true, data: rows.map(announcementView) });
    } catch (error) {
      return res.json({ success: true, data: [] });
    }
  },

  // GET /admin/messaging/announcements
  listAnnouncements: async (req, res) => {
    try {
      const rows = await Announcement.find({}).sort({ createdAt: -1 }).limit(200).lean();
      return res.json({ success: true, data: rows.map(announcementView) });
    } catch (error) {
      console.error('[messaging] announcements failed:', error);
      return fail(res, 500, 'Could not load announcements');
    }
  },

  // POST /admin/messaging/announcements
  createAnnouncement: async (req, res) => {
    try {
      const body = req.body || {};
      if (!String(body.title || '').trim()) return fail(res, 400, 'A title is required');
      const doc = await Announcement.create({
        title: String(body.title).trim(),
        body: String(body.body || '').trim(),
        audience: ['members', 'public', 'all'].includes(body.audience) ? body.audience : 'members',
        tone: ['info', 'success', 'warning'].includes(body.tone) ? body.tone : 'info',
        url: String(body.url || '').trim(),
        urlLabel: String(body.urlLabel || body.url_label || '').trim(),
        startsAt: readDate(body.startsAt || body.starts_at, 'start'),
        endsAt: readDate(body.endsAt || body.ends_at, 'end'),
        isActive: body.isActive === undefined && body.is_active === undefined ? true : !!(body.isActive ?? body.is_active),
        createdBy: actorId(req)
      });
      return res.status(201).json({ success: true, data: announcementView(doc) });
    } catch (error) {
      console.error('[messaging] create announcement failed:', error);
      return fail(res, 500, 'Could not create the announcement');
    }
  },

  // PUT /admin/messaging/announcements/:id
  updateAnnouncement: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 400, 'Invalid announcement id');
      const doc = await Announcement.findById(req.params.id);
      if (!doc) return fail(res, 404, 'Announcement not found');
      const body = req.body || {};
      if (body.title !== undefined) doc.title = String(body.title).trim() || doc.title;
      if (body.body !== undefined) doc.body = String(body.body).trim();
      if (body.audience !== undefined && ['members', 'public', 'all'].includes(body.audience)) doc.audience = body.audience;
      if (body.tone !== undefined && ['info', 'success', 'warning'].includes(body.tone)) doc.tone = body.tone;
      if (body.url !== undefined) doc.url = String(body.url).trim();
      if (body.urlLabel !== undefined || body.url_label !== undefined) doc.urlLabel = String(body.urlLabel ?? body.url_label ?? '').trim();
      if (body.startsAt !== undefined || body.starts_at !== undefined) doc.startsAt = readDate(body.startsAt ?? body.starts_at, 'start');
      if (body.endsAt !== undefined || body.ends_at !== undefined) doc.endsAt = readDate(body.endsAt ?? body.ends_at, 'end');
      if (body.isActive !== undefined || body.is_active !== undefined) doc.isActive = !!(body.isActive ?? body.is_active);
      await doc.save();
      return res.json({ success: true, data: announcementView(doc) });
    } catch (error) {
      console.error('[messaging] update announcement failed:', error);
      return fail(res, 500, 'Could not update the announcement');
    }
  },

  // DELETE /admin/messaging/announcements/:id
  deleteAnnouncement: async (req, res) => {
    try {
      if (!isId(req.params.id)) return fail(res, 400, 'Invalid announcement id');
      await Announcement.deleteOne({ _id: req.params.id });
      return res.json({ success: true, message: 'Announcement deleted.' });
    } catch (error) {
      console.error('[messaging] delete announcement failed:', error);
      return fail(res, 500, 'Could not delete the announcement');
    }
  },

  // POST /admin/messaging/automations/run   { dryRun }  -> runs the nudges now
  runAutomationsNow: async (req, res) => {
    try {
      const dryRun = !!((req.body || {}).dryRun);
      const result = await runAutomations({ dryRun, verbose: true });
      return res.json({ success: true, dryRun, data: result });
    } catch (error) {
      console.error('[messaging] automations failed:', error);
      return fail(res, 500, 'Could not run the automations');
    }
  },

  // POST /settings/push/keys  -> generates VAPID keys and switches push on
  generatePushKeys: async (req, res) => {
    try {
      const settings = await Settings.findOne({ isActive: true });
      if (!settings) return fail(res, 404, 'Settings not found');
      const existing = (settings.messaging && settings.messaging.push) || {};
      if (existing.vapidPublicKey && existing.vapidPrivateKey && !(req.body && req.body.rotate === true)) {
        settings.set('messaging.push.enabled', true);
        await settings.save();
        return res.json({ success: true, message: 'Push notifications are on.', data: { publicKey: existing.vapidPublicKey } });
      }
      const keys = messaging.generateVapidKeys();
      const subject = existing.subject || (settings.smtp && settings.smtp.fromEmail ? `mailto:${settings.smtp.fromEmail}` : '');
      settings.set('messaging.push', { enabled: true, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, subject });
      await settings.save();
      if (existing.vapidPublicKey) {
        // Old subscriptions were made against the old key and will all fail.
        await PushSubscription.deleteMany({});
      }
      notify.resetBrandCache();
      return res.json({ success: true, message: 'Push notifications are on. Members can now allow them in their account.', data: { publicKey: keys.publicKey } });
    } catch (error) {
      console.error('[messaging] push keys failed:', error);
      return fail(res, 500, 'Could not set up push notifications');
    }
  },

  // ---- member side ----------------------------------------------------------

  // GET /user/notification-preferences
  myPreferences: async (req, res) => {
    try {
      const me = await User.findById(actorId(req)).select('phone notificationPreferences').lean();
      if (!me) return fail(res, 404, 'Account not found');
      const [available, settings, devices] = await Promise.all([
        messaging.channels(),
        Settings.getSettings().catch(() => null),
        PushSubscription.countDocuments({ userId: me._id })
      ]);
      const push = (settings && settings.messaging && settings.messaging.push) || {};
      return res.json({
        success: true,
        data: {
          preferences: { email: true, sms: true, whatsapp: true, push: true, marketing: true, ...(me.notificationPreferences || {}) },
          phone: me.phone || '',
          channels: available,
          push_public_key: push.enabled ? push.vapidPublicKey || '' : '',
          push_devices: devices
        }
      });
    } catch (error) {
      console.error('[messaging] preferences failed:', error);
      return fail(res, 500, 'Could not load your notification settings');
    }
  },

  // PUT /user/notification-preferences   { email, sms, whatsapp, push, marketing }
  setMyPreferences: async (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      for (const key of ['email', 'sms', 'whatsapp', 'push', 'marketing']) {
        if (body[key] !== undefined) patch[`notificationPreferences.${key}`] = body[key] === true || body[key] === 'true';
      }
      if (!Object.keys(patch).length) return fail(res, 400, 'Nothing to update');
      const me = await User.findByIdAndUpdate(actorId(req), { $set: patch }, { new: true }).select('notificationPreferences').lean();
      if (!me) return fail(res, 404, 'Account not found');
      return res.json({ success: true, message: 'Saved.', data: me.notificationPreferences });
    } catch (error) {
      console.error('[messaging] set preferences failed:', error);
      return fail(res, 500, 'Could not save your notification settings');
    }
  },

  // POST /user/push-subscriptions   { subscription: { endpoint, keys } }
  subscribePush: async (req, res) => {
    try {
      const sub = (req.body || {}).subscription || req.body || {};
      const endpoint = String(sub.endpoint || '').trim();
      const keys = sub.keys || {};
      if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) return fail(res, 400, 'A valid push subscription is required');
      await PushSubscription.findOneAndUpdate(
        { endpoint },
        { $set: { userId: actorId(req), keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) }, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return res.json({ success: true, message: 'This device will receive notifications.' });
    } catch (error) {
      console.error('[messaging] subscribe failed:', error);
      return fail(res, 500, 'Could not register this device');
    }
  },

  // DELETE /user/push-subscriptions   { endpoint }
  unsubscribePush: async (req, res) => {
    try {
      const endpoint = String((req.body || {}).endpoint || '').trim();
      const filter = endpoint ? { endpoint, userId: actorId(req) } : { userId: actorId(req) };
      const result = await PushSubscription.deleteMany(filter);
      return res.json({ success: true, message: 'Notifications are off for this device.', removed: result.deletedCount || 0 });
    } catch (error) {
      console.error('[messaging] unsubscribe failed:', error);
      return fail(res, 500, 'Could not remove this device');
    }
  }
};
