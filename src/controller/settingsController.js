// src/controller/settingsController.js

const Settings = require('../models/settings');
const fs = require('fs').promises;
const path = require('path');
const { localUploadPath } = require('../helper/upload');

// Secrets are stored so the admin UI can manage them, but they must never be
// echoed back in full: a masked preview is enough to confirm what is saved.
const MASK_CHAR = '•';
function maskSecret(value) {
  if (!value) return '';
  const str = String(value);
  if (str.length <= 4) return MASK_CHAR.repeat(str.length);
  return MASK_CHAR.repeat(8) + str.slice(-4);
}
// A value the admin never edited comes back containing mask characters; writing
// it through would replace the real secret with dots.
function isMasked(value) {
  return typeof value === 'string' && value.includes(MASK_CHAR);
}

// What to store for a secret field on save. An absent field or the untouched
// masked preview keeps the stored value. A value that still contains mask
// characters but is not the preview -- a paste that landed after the dots --
// cannot be what the admin meant, so the stored value is kept and a warning
// says so, rather than silently saving dots as a password.
function resolveSecret(label, incoming, existing, warnings, { trim = true } = {}) {
  if (incoming === undefined) return existing || '';
  if (!isMasked(incoming)) return trim ? String(incoming).trim() : String(incoming);
  if (incoming !== maskSecret(existing)) {
    warnings.push(`${label} was not changed because the masked value was edited. Clear the field and paste the whole value to replace it.`);
  }
  return existing || '';
}

// Every response that returns the settings document must go through this.
// Logo upload/remove and reset all echo the document back, and without this
// they leaked the SMTP password and Stripe secrets in cleartext.
function sanitizeSettings(doc) {
  if (!doc) return doc;
  const data = doc.toObject ? doc.toObject() : { ...doc };
  if (data.stripe) {
    data.stripe = {
      ...data.stripe,
      secretKey: maskSecret(data.stripe.secretKey),
      webhookSecret: maskSecret(data.stripe.webhookSecret),
      secretKeySet: !!data.stripe.secretKey,
      webhookSecretSet: !!data.stripe.webhookSecret,
    };
  }
  if (data.smtp) {
    data.smtp = {
      ...data.smtp,
      pass: maskSecret(data.smtp.pass),
      passSet: !!data.smtp.pass,
    };
  }
  if (data.messaging) {
    const m = data.messaging;
    const secret = (obj, key) => ({ [key]: maskSecret(obj && obj[key]), [`${key}Set`]: !!(obj && obj[key]) });
    data.messaging = {
      ...m,
      sms: { ...(m.sms || {}), ...secret(m.sms, 'authToken'), ...secret(m.sms, 'webhookToken') },
      whatsapp: { ...(m.whatsapp || {}), ...secret(m.whatsapp, 'authToken'), ...secret(m.whatsapp, 'accessToken'), ...secret(m.whatsapp, 'webhookToken') },
      push: { ...(m.push || {}), ...secret(m.push, 'vapidPrivateKey') }
    };
  }
  return data;
}

// Nested messaging settings: every field optional, secrets kept when the
// admin sends back the masked value (see resolveSecret).
function mergeMessaging(existing = {}, incoming = {}, warnings = []) {
  const ex = existing || {};
  const text = (obj, key, fallback = '') => (obj && obj[key] !== undefined ? String(obj[key]).trim() : fallback);
  const secret = (obj, key, fallback = '', label = key) => resolveSecret(label, obj && obj[key], fallback, warnings);
  const bool = (obj, key, fallback) => (obj && obj[key] !== undefined ? Boolean(obj[key]) : fallback);
  const sms = ex.sms || {};
  const wa = ex.whatsapp || {};
  const push = ex.push || {};
  const tx = ex.transactional || {};
  const btn = ex.whatsappButton || {};
  const auto = ex.automations || {};
  const inSms = incoming.sms || {};
  const inWa = incoming.whatsapp || {};
  const inPush = incoming.push || {};
  const inTx = incoming.transactional || {};
  const inBtn = incoming.whatsappButton || {};
  const inAuto = incoming.automations || {};
  const provider = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback || 'none');
  return {
    defaultCountryCode: text(incoming, 'defaultCountryCode', ex.defaultCountryCode || ''),
    sms: {
      provider: inSms.provider !== undefined ? provider(inSms.provider, ['none', 'twilio', 'http']) : sms.provider || 'none',
      accountSid: text(inSms, 'accountSid', sms.accountSid || ''),
      authToken: secret(inSms, 'authToken', sms.authToken || '', 'The SMS auth token'),
      from: text(inSms, 'from', sms.from || ''),
      webhookUrl: text(inSms, 'webhookUrl', sms.webhookUrl || ''),
      webhookToken: secret(inSms, 'webhookToken', sms.webhookToken || '', 'The SMS webhook token')
    },
    whatsapp: {
      provider: inWa.provider !== undefined ? provider(inWa.provider, ['none', 'twilio', 'meta', 'http']) : wa.provider || 'none',
      accountSid: text(inWa, 'accountSid', wa.accountSid || ''),
      authToken: secret(inWa, 'authToken', wa.authToken || '', 'The WhatsApp auth token'),
      from: text(inWa, 'from', wa.from || ''),
      phoneNumberId: text(inWa, 'phoneNumberId', wa.phoneNumberId || ''),
      accessToken: secret(inWa, 'accessToken', wa.accessToken || '', 'The WhatsApp access token'),
      webhookUrl: text(inWa, 'webhookUrl', wa.webhookUrl || ''),
      webhookToken: secret(inWa, 'webhookToken', wa.webhookToken || '', 'The WhatsApp webhook token')
    },
    push: {
      // Keys are only ever made by POST /settings/push/keys; the switch and
      // the contact address are editable here.
      enabled: bool(inPush, 'enabled', !!push.enabled) && !!push.vapidPublicKey,
      vapidPublicKey: push.vapidPublicKey || '',
      vapidPrivateKey: push.vapidPrivateKey || '',
      subject: text(inPush, 'subject', push.subject || '')
    },
    transactional: {
      sms: bool(inTx, 'sms', !!tx.sms),
      whatsapp: bool(inTx, 'whatsapp', !!tx.whatsapp),
      push: bool(inTx, 'push', tx.push !== false)
    },
    whatsappButton: {
      enabled: bool(inBtn, 'enabled', !!btn.enabled),
      number: text(inBtn, 'number', btn.number || ''),
      message: text(inBtn, 'message', btn.message || '')
    },
    automations: {
      absentDays: inAuto.absentDays !== undefined ? Math.max(0, parseInt(inAuto.absentDays, 10) || 0) : auto.absentDays || 0,
      winBackDays: inAuto.winBackDays !== undefined ? Math.max(0, parseInt(inAuto.winBackDays, 10) || 0) : auto.winBackDays || 0,
      birthday: bool(inAuto, 'birthday', !!auto.birthday)
    }
  };
}

// A social profile link as the footer and the structured data will use it.
// Blank clears it; "instagram.com/ironworks" gains its https://; anything
// with another scheme (javascript:, data:) is refused, since the value goes
// straight into an <a href> on every page of the site. What is stored is the
// address as URL parsing normalised it (url.href), not the text typed:
// characters such as < > " and spaces come back percent-encoded, so the link
// cannot carry markup into the page or its structured data. Returns null for
// a refused value.
function webLink(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text.replace(/^\/+/, '')}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.href.slice(0, 500);
}

// Loose on purpose: the address is shown and linked with mailto:, not
// delivered to, so all it has to be is one address.
function looksLikeEmail(value) {
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value);
}


// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

const settingsController = {
  // GET /settings/public - Get public settings (no auth required)
  getPublicSettings: async (req, res) => {
    try {
      const settings = await Settings.getSettings();

      // Return only public-safe settings
      const { themeFor } = require('../config/themes');
      const theme = themeFor(settings.theme);

      const publicSettings = {
        siteName: settings.siteName,
        theme: theme.key,
        // The six colours behind that theme, so a client that cannot read the
        // website's own palette file -- the phone app -- can still paint
        // itself in the gym's colours.
        themeTokens: theme.tokens,
        // Publishable key only — the secret and webhook values must never
        // leave the server through a public endpoint.
        stripePublishableKey: settings.stripe?.enabled ? (settings.stripe?.publishableKey || '') : '',
        stripeEnabled: !!settings.stripe?.enabled,
        siteUrl: settings.siteUrl,
        logoUrl: settings.logoUrl,
        logoWidth: settings.logoWidth || 160,
        logoHeight: settings.logoHeight || 56,
        footerLogoUrl: settings.footerLogoUrl || '',
        footerLogoWidth: settings.footerLogoWidth || 120,
        footerLogoHeight: settings.footerLogoHeight || 40,
        mobileNumber: settings.mobileNumber || '',
        address: settings.address || '',
        contactEmail: settings.contactEmail || '',
        siteDescription: settings.siteDescription || '',
        currency: settings.currency,
        taxRate: settings.taxRate || 0,
        topSliderText: settings.topSliderText || '',
        youtubeUrl: settings.youtubeUrl,
        facebookUrl: settings.facebookUrl,
        instagramUrl: settings.instagramUrl,
        twitterUrl: settings.twitterUrl,
        tiktokUrl: settings.tiktokUrl,
        // The floating WhatsApp button and the key browsers need to subscribe
        // to push. Neither is secret.
        whatsappButton: settings.messaging?.whatsappButton?.enabled && settings.messaging.whatsappButton.number
          ? { number: settings.messaging.whatsappButton.number, message: settings.messaging.whatsappButton.message || '' }
          : null,
        pushPublicKey: settings.messaging?.push?.enabled ? settings.messaging.push.vapidPublicKey || '' : '',
        seo: settings.seo || {},
        maps: settings.maps || {},
        openingHours: settings.openingHours || [],
        locale: settings.locale || { language: 'en', direction: 'ltr' },
        // What the sign-in page may offer. Google needs all three values for
        // the redirect flow to complete, so a half-configured deployment
        // shows no button rather than a button that ends in an error page.
        features: {
          googleSignIn: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI)
        }
      };

      return res.status(200).json({
        success: true,
        data: publicSettings
      });
    } catch (error) {
      console.error('Get public settings error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve settings',
        error: error.message
      });
    }
  },

  // GET /settings - Get current settings
  // POST /settings/test-smtp - verify the saved mail credentials actually work
  testSmtp: async (req, res) => {
    try {
      const { verifyConnection } = require('../services/emailService');
      const result = await verifyConnection();
      if (result && result.ok) {
        return res.status(200).json({ success: true, message: 'SMTP connection verified' });
      }
      return res.status(400).json({
        success: false,
        message: 'SMTP connection failed',
        error: (result && result.error) || 'Unknown error',
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: 'SMTP test failed', error: error.message });
    }
  },

  getSettings: async (req, res) => {
    try {
      const settings = await Settings.getSettings();
      const data = sanitizeSettings(settings);

      // Platform-level facts about this gym that the settings screen shows
      // and edits alongside the gym's own settings.
      const { currentTenant } = require('../platform/tenantContext');
      const gym = currentTenant();
      data.ianaTimezone = (gym && gym.locale && gym.locale.timezone) || process.env.ATTENDANCE_TIMEZONE || 'UTC';
      data.country = settings.country || (gym && gym.locale && gym.locale.country) || '';
      data.gymSlug = gym ? gym.slug : null;
      const apiBase = `${req.protocol}://${req.get('host')}`;
      data.stripeWebhookUrl = gym ? `${apiBase}/api/gymfolio/payment/webhook/${gym.slug}` : `${apiBase}/api/gymfolio/payment/webhook`;

      return res.status(200).json({
        success: true,
        message: 'Settings retrieved successfully',
        data
      });
    } catch (error) {
      console.error('Get settings error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve settings',
        error: error.message
      });
    }
  },

  // POST /settings/stripe/test { secretKey? } - prove a key reaches a Stripe account
  //
  // Tests the key the admin has just typed, or -- when the field holds the
  // masked preview -- the stored one, so "Test connection" answers for what
  // will actually be saved. Stripe's own wording on failure ("Invalid API
  // Key provided: sk_test_***") is the useful part; nothing about our server
  // is, so it is passed through as the message.
  testStripe: async (req, res) => {
    try {
      const Stripe = require('stripe');
      const { stripeConfig, API_VERSION } = require('../services/stripeClient');

      const typed = req.body && req.body.secretKey !== undefined && !isMasked(req.body.secretKey)
        ? String(req.body.secretKey).trim()
        : '';
      let secretKey = typed;
      if (!secretKey) {
        const settings = await Settings.getSettings();
        secretKey = (settings.stripe && settings.stripe.secretKey) || '';
      }
      if (!secretKey) {
        // The gym a single-gym deployment defaults to may run on the
        // environment's keys (services/stripeClient.js).
        secretKey = (await stripeConfig()).secretKey || '';
      }
      if (!secretKey) {
        return res.status(400).json({ success: false, message: 'Enter a Stripe secret key, or save one first.' });
      }

      const stripe = new Stripe(secretKey, { apiVersion: API_VERSION });
      const account = await stripe.accounts.retrieve();
      const accountName =
        (account.settings && account.settings.dashboard && account.settings.dashboard.display_name) ||
        (account.business_profile && account.business_profile.name) ||
        account.email ||
        account.id;

      return res.status(200).json({
        success: true,
        message: `Connected to ${accountName}`,
        data: { accountId: account.id, accountName, chargesEnabled: !!account.charges_enabled }
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: (error && error.message) || 'Stripe rejected the key'
      });
    }
  },

  // PUT /settings - Update settings
  updateSettings: async (req, res) => {
    try {
      // Things the admin should know about a save that otherwise succeeded:
      // a secret that was kept because its masked preview came back edited.
      const warnings = [];

      // The stored document, read once and only when a branch needs it.
      let currentDoc = null;
      const currentSettings = async () => currentDoc || (currentDoc = await Settings.getSettings());

      const {
        siteName,
        siteUrl,
        mobileNumber,
        address,
        contactEmail,
        siteDescription,
        timezone,
        dateFormat,
        emailNotifications,
        marketingEmails,
        securityAlerts,
        twoFactorAuth,
        currency,
        taxRate,
        paymentMethods,
        topSliderText,
        logoWidth,
        logoHeight,
        footerLogoWidth,
        footerLogoHeight,
        youtubeUrl,
        facebookUrl,
        instagramUrl,
        twitterUrl,
        tiktokUrl,
        theme,
        stripe,
        smtp,
        invoice,
        membership,
        ianaTimezone,
        country,
        setupCompleted,
        messaging,
        booking,
        pt,
        rooms,
        seo,
        maps,
        openingHours,
        locale
      } = req.body;

      // Prepare update data with only provided fields
      const updateData = {};

      // The gym's clock lives on its platform record (every gym has its own),
      // edited here so the owner does not need the platform panel for it.
      let timezoneChanged = false;
      if (ianaTimezone !== undefined) {
        const tz = String(ianaTimezone || '').trim();
        try {
          new Intl.DateTimeFormat('en-GB', { timeZone: tz });
        } catch {
          return res.status(400).json({ success: false, message: `"${tz}" is not a valid timezone (use an IANA name such as Europe/London)` });
        }
        const { currentTenant } = require('../platform/tenantContext');
        const gym = currentTenant();
        if (gym) {
          const Gym = require('../platform/models/gymModel');
          const { invalidateTenantCache } = require('../platform/middleware/resolveTenant');
          await Gym.updateOne({ _id: gym._id }, { $set: { 'locale.timezone': tz } });
          invalidateTenantCache();
          gym.locale = { ...(gym.locale || {}), timezone: tz };
          timezoneChanged = true;
        }
      }

      if (setupCompleted !== undefined) {
        updateData.setupCompletedAt = setupCompleted ? new Date() : null;
      }

      if (invoice && typeof invoice === 'object') {
        updateData.invoice = {
          prefix: String(invoice.prefix || 'INV').trim().toUpperCase() || 'INV',
          taxLabel: String(invoice.taxLabel || 'Tax').trim() || 'Tax',
          taxNumber: String(invoice.taxNumber || '').trim(),
          footerNote: String(invoice.footerNote || '').trim()
        };
      }
      if (membership && typeof membership === 'object') {
        const existingMembership = (await Settings.findOne({ isActive: true }).select('membership').lean())?.membership || {};
        const existingWaiver = existingMembership.waiver || {};
        const waiver = membership.waiver && typeof membership.waiver === 'object' ? membership.waiver : {};
        updateData.membership = {
          allowMemberFreeze: membership.allowMemberFreeze !== undefined ? Boolean(membership.allowMemberFreeze) : true,
          maxFreezeDays: Math.max(1, parseInt(membership.maxFreezeDays, 10) || 30),
          allowMemberCancel: membership.allowMemberCancel !== undefined ? Boolean(membership.allowMemberCancel) : true,
          waiver: {
            required: waiver.required !== undefined ? Boolean(waiver.required) : !!existingWaiver.required,
            version: waiver.version !== undefined ? String(waiver.version).trim().slice(0, 20) || '1.0' : existingWaiver.version || '1.0',
            text: waiver.text !== undefined ? String(waiver.text).slice(0, 50000) : existingWaiver.text || ''
          }
        };
      }
      if (messaging && typeof messaging === 'object') {
        // Read through getSettings() (not .lean()) so the stored tokens come
        // back opened: the masked-preview comparison in resolveSecret has to
        // see the same plaintext the admin's screen was masked from.
        const current = await currentSettings();
        updateData.messaging = mergeMessaging((current && current.messaging) || {}, messaging, warnings);
      }
      if (seo && typeof seo === 'object') {
        updateData.seo = {
          title: String(seo.title || '').trim().slice(0, 120),
          description: String(seo.description || '').trim().slice(0, 300),
          keywords: String(seo.keywords || '').trim().slice(0, 300),
          ogImage: String(seo.ogImage || '').trim().slice(0, 500)
        };
      }
      if (maps && typeof maps === 'object') {
        const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
        // Only an embed from Google's "share → embed a map" is accepted, so
        // the contact page never frames an arbitrary site.
        const embedUrl = String(maps.embedUrl || '').trim();
        updateData.maps = {
          embedUrl: /^https:\/\/www\.google\.com\/maps\/embed/.test(embedUrl) ? embedUrl.slice(0, 2000) : '',
          placeUrl: /^https:\/\/(www\.google\.com\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)/.test(String(maps.placeUrl || '').trim()) ? String(maps.placeUrl).trim().slice(0, 500) : '',
          latitude: num(maps.latitude),
          longitude: num(maps.longitude)
        };
      }
      if (Array.isArray(openingHours)) {
        const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const clock = (v, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : fallback);
        updateData.openingHours = DAYS.map((day) => {
          const row = openingHours.find((r) => r && r.day === day) || {};
          return { day, open: clock(row.open, '06:00'), close: clock(row.close, '22:00'), closed: row.closed === true || row.closed === 'true' };
        });
      }
      if (locale && typeof locale === 'object') {
        updateData.locale = {
          language: String(locale.language || 'en').trim().toLowerCase().slice(0, 10) || 'en',
          direction: locale.direction === 'rtl' ? 'rtl' : 'ltr'
        };
      }
      if ((booking && typeof booking === 'object') || (pt && typeof pt === 'object') || Array.isArray(rooms)) {
        const rules = require('../gymfolio/services/bookingRules');
        const currentDoc = await Settings.findOne({ isActive: true }).select('booking pt rooms').lean();
        if (booking && typeof booking === 'object') updateData.booking = rules.normalizeBooking({ ...((currentDoc && currentDoc.booking) || {}), ...booking });
        if (pt && typeof pt === 'object') updateData.pt = rules.normalizePt({ ...((currentDoc && currentDoc.pt) || {}), ...pt });
        if (Array.isArray(rooms)) updateData.rooms = [...new Set(rooms.map((r) => String(r).trim()).filter(Boolean))].slice(0, 50);
        rules.resetRulesCache();
      }

      // Update only provided fields
      if (theme !== undefined) updateData.theme = String(theme).trim();

      // Nested credential groups are merged field by field so that a masked
      // value (one the admin never retyped) leaves the stored secret intact.
      if (stripe && typeof stripe === 'object') {
        const current = await currentSettings();
        const existing = current.stripe || {};
        updateData.stripe = {
          publishableKey:
            stripe.publishableKey !== undefined
              ? String(stripe.publishableKey).trim()
              : existing.publishableKey || '',
          secretKey: resolveSecret('The Stripe secret key', stripe.secretKey, existing.secretKey, warnings),
          webhookSecret: resolveSecret('The Stripe webhook secret', stripe.webhookSecret, existing.webhookSecret, warnings),
          enabled: stripe.enabled !== undefined ? Boolean(stripe.enabled) : !!existing.enabled,
        };
      }

      if (smtp && typeof smtp === 'object') {
        const current = await currentSettings();
        const existing = current.smtp || {};
        updateData.smtp = {
          host: smtp.host !== undefined ? String(smtp.host).trim() : existing.host || '',
          port: smtp.port !== undefined ? Number(smtp.port) || 587 : existing.port || 587,
          secure: smtp.secure !== undefined ? Boolean(smtp.secure) : !!existing.secure,
          user: smtp.user !== undefined ? String(smtp.user).trim() : existing.user || '',
          pass: resolveSecret('The SMTP password', smtp.pass, existing.pass, warnings, { trim: false }),
          fromName: smtp.fromName !== undefined ? String(smtp.fromName).trim() : existing.fromName || '',
          fromEmail: smtp.fromEmail !== undefined ? String(smtp.fromEmail).trim() : existing.fromEmail || '',
        };
      }
      if (siteName !== undefined) updateData.siteName = String(siteName ?? '').trim();
      if (siteUrl !== undefined) updateData.siteUrl = String(siteUrl ?? '').trim();
      if (mobileNumber !== undefined) updateData.mobileNumber = String(mobileNumber ?? '').trim();
      if (address !== undefined) updateData.address = String(address ?? '').trim();
      if (contactEmail !== undefined) {
        const email = String(contactEmail ?? '').trim().toLowerCase();
        if (email && !looksLikeEmail(email)) {
          return res.status(400).json({ success: false, message: `"${email.slice(0, 80)}" is not an email address` });
        }
        updateData.contactEmail = email.slice(0, 200);
      }
      if (siteDescription !== undefined) updateData.siteDescription = String(siteDescription ?? '').trim().slice(0, 1000);
      if (timezone !== undefined) updateData.timezone = timezone;
      if (dateFormat !== undefined) updateData.dateFormat = dateFormat;
      if (emailNotifications !== undefined) updateData.emailNotifications = Boolean(emailNotifications);
      if (marketingEmails !== undefined) updateData.marketingEmails = Boolean(marketingEmails);
      if (securityAlerts !== undefined) updateData.securityAlerts = Boolean(securityAlerts);
      if (twoFactorAuth !== undefined) {
        const enabling = twoFactorAuth === true || twoFactorAuth === 'true';
        const current = await currentSettings();
        // Requiring an emailed code for every staff sign-in is only safe once
        // email provably works; otherwise the whole staff is locked out. The
        // check runs when the switch is being turned ON -- not on every save
        // of a page that happens to carry the setting, which used to make an
        // SMTP hiccup block unrelated edits.
        if (enabling && !current.twoFactorAuth) {
          const { verifyConnection } = require('../services/emailService');
          const smtpCheck = await verifyConnection();
          if (!smtpCheck.ok) {
            return res.status(409).json({
              success: false,
              message: `Fix outgoing email before requiring two-factor sign-in (SMTP check failed: ${smtpCheck.error}).`
            });
          }
        }
        updateData.twoFactorAuth = enabling;
      }
      if (currency !== undefined) {
        const code = String(currency || '').toUpperCase().trim();
        if (!/^[A-Z]{3}$/.test(code)) {
          return res.status(400).json({ success: false, message: 'Currency must be a 3-letter ISO code such as USD, GBP or PKR' });
        }
        updateData.currency = code;
      }
      if (country !== undefined) {
        const code = String(country || '').toUpperCase().trim();
        if (code && !/^[A-Z]{2}$/.test(code)) {
          return res.status(400).json({ success: false, message: 'Country must be a 2-letter ISO code such as GB, AE or PK' });
        }
        updateData.country = code;
      }
      // The gym's platform record carries the same country and currency (the
      // panel shows them); keep the two in step.
      if (updateData.currency !== undefined || updateData.country !== undefined) {
        const { currentTenant } = require('../platform/tenantContext');
        const gym = currentTenant();
        if (gym) {
          const Gym = require('../platform/models/gymModel');
          const { invalidateTenantCache } = require('../platform/middleware/resolveTenant');
          const set = {};
          if (updateData.currency !== undefined) set['locale.currency'] = updateData.currency;
          if (updateData.country !== undefined) set['locale.country'] = updateData.country;
          await Gym.updateOne({ _id: gym._id }, { $set: set });
          invalidateTenantCache();
          gym.locale = { ...(gym.locale || {}), ...(updateData.currency !== undefined ? { currency: updateData.currency } : {}), ...(updateData.country !== undefined ? { country: updateData.country } : {}) };
        }
      }
      if (taxRate !== undefined) updateData.taxRate = Number(taxRate);
      if (topSliderText !== undefined) updateData.topSliderText = String(topSliderText ?? '').trim();
      if (logoWidth !== undefined) updateData.logoWidth = Number(logoWidth);
      if (logoHeight !== undefined) updateData.logoHeight = Number(logoHeight);
      if (footerLogoWidth !== undefined) updateData.footerLogoWidth = Number(footerLogoWidth);
      if (footerLogoHeight !== undefined) updateData.footerLogoHeight = Number(footerLogoHeight);

      // Handle social links
      const socials = [
        ['youtubeUrl', youtubeUrl, 'YouTube'],
        ['facebookUrl', facebookUrl, 'Facebook'],
        ['instagramUrl', instagramUrl, 'Instagram'],
        ['twitterUrl', twitterUrl, 'X (Twitter)'],
        ['tiktokUrl', tiktokUrl, 'TikTok']
      ];
      for (const [key, value, label] of socials) {
        if (value === undefined) continue;
        const link = webLink(value);
        if (link === null) {
          return res.status(400).json({ success: false, message: `The ${label} link must be a web address (https://…)` });
        }
        updateData[key] = link;
      }

      // Handle payment methods array
      if (paymentMethods && Array.isArray(paymentMethods)) {
        updateData.paymentMethods = paymentMethods.filter(method =>
          ['credit_card', 'paypal', 'stripe', 'razorpay'].includes(method)
        );
      }

      // Ensure we have some data to update
      if (Object.keys(updateData).length === 0) {
        if (timezoneChanged) {
          const settings = await Settings.getSettings();
          return res.status(200).json({ success: true, message: 'Settings updated successfully', data: sanitizeSettings(settings), warnings });
        }
        return res.status(400).json({
          success: false,
          message: 'No valid fields provided for update'
        });
      }

      // Update settings
      const updatedSettings = await Settings.updateSettings(updateData);

      return res.status(200).json({
        success: true,
        message: warnings.length ? 'Settings updated, with warnings' : 'Settings updated successfully',
        data: sanitizeSettings(updatedSettings),
        warnings
      });
    } catch (error) {
      console.error('Update settings error:', error);
      
      if (error.name === 'ValidationError') {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to update settings',
        error: error.message
      });
    }
  },

  // POST /settings/logo - Upload logo
  uploadLogo: async (req, res) => {
    try {
      const logoFile = req.files?.logo?.[0];
      
      if (!logoFile) {
        return res.status(400).json({
          success: false,
          message: 'Logo file is required'
        });
      }

      // Validate file type
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(logoFile.mimetype)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid file type. Please upload PNG, JPG, GIF, or WebP images only.'
        });
      }

      // Validate file size (5MB)
      if (logoFile.size > 5 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          message: 'File size too large. Maximum size allowed is 5MB.'
        });
      }

      // Generate new logo URL
      let logoUrl;
      if (USE_BLOB_STORAGE && blobUpload) {
        logoUrl = await blobUpload.uploadToBlob(
          logoFile.buffer, logoFile.originalname, logoFile.mimetype, 'settings'
        );
      } else {
        logoUrl = `/uploads/${logoFile.filename}`;
      }

      // Get current settings to backup old logo
      const currentSettings = await Settings.getSettings();
      const oldLogoUrl = currentSettings.logoUrl;

      // Update settings with new logo URL
      const updatedSettings = await Settings.updateSettings({ logoUrl });

      // Remove old logo file if it exists and is not the default
      if (oldLogoUrl && oldLogoUrl !== '/images/logo.png' && oldLogoUrl.startsWith('/uploads/')) {
        try {
          const oldLogoPath = localUploadPath(oldLogoUrl);
          if (!oldLogoPath) throw new Error('not inside the uploads directory');
          await fs.access(oldLogoPath); // Check if file exists
          await fs.unlink(oldLogoPath); // Delete old logo
          console.log('Old logo deleted:', oldLogoPath);
        } catch (err) {
          console.log('Could not delete old logo:', err.message);
          // Don't fail the request if old logo deletion fails
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Logo uploaded successfully',
        data: {
          logoUrl,
          settings: sanitizeSettings(updatedSettings)
        }
      });
    } catch (error) {
      console.error('Upload logo error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload logo',
        error: error.message
      });
    }
  },

  // POST /settings/footer-logo - Upload footer logo
  uploadFooterLogo: async (req, res) => {
    try {
      const logoFile = req.files?.footerLogo?.[0];

      if (!logoFile) {
        return res.status(400).json({
          success: false,
          message: 'Footer logo file is required'
        });
      }

      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(logoFile.mimetype)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid file type. Please upload PNG, JPG, GIF, or WebP images only.'
        });
      }

      if (logoFile.size > 5 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          message: 'File size too large. Maximum size allowed is 5MB.'
        });
      }

      let footerLogoUrl;
      if (USE_BLOB_STORAGE && blobUpload) {
        footerLogoUrl = await blobUpload.uploadToBlob(
          logoFile.buffer, logoFile.originalname, logoFile.mimetype, 'settings'
        );
      } else {
        footerLogoUrl = `/uploads/${logoFile.filename}`;
      }

      const currentSettings = await Settings.getSettings();
      const oldFooterLogoUrl = currentSettings.footerLogoUrl;

      const updatedSettings = await Settings.updateSettings({ footerLogoUrl });

      if (oldFooterLogoUrl && oldFooterLogoUrl.startsWith('/uploads/')) {
        try {
          const oldLogoPath = localUploadPath(oldFooterLogoUrl);
          if (!oldLogoPath) throw new Error('not inside the uploads directory');
          await fs.access(oldLogoPath);
          await fs.unlink(oldLogoPath);
        } catch (err) {
          console.log('Could not delete old footer logo:', err.message);
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Footer logo uploaded successfully',
        data: {
          footerLogoUrl,
          settings: sanitizeSettings(updatedSettings)
        }
      });
    } catch (error) {
      console.error('Upload footer logo error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload footer logo',
        error: error.message
      });
    }
  },

  // DELETE /settings/footer-logo - Remove footer logo
  removeFooterLogo: async (req, res) => {
    try {
      const currentSettings = await Settings.getSettings();
      const currentFooterLogoUrl = currentSettings.footerLogoUrl;

      const updatedSettings = await Settings.updateSettings({ footerLogoUrl: '' });

      if (currentFooterLogoUrl && currentFooterLogoUrl.startsWith('/uploads/')) {
        try {
          const logoPath = localUploadPath(currentFooterLogoUrl);
          if (!logoPath) throw new Error('not inside the uploads directory');
          await fs.access(logoPath);
          await fs.unlink(logoPath);
        } catch (err) {
          console.log('Could not delete footer logo file:', err.message);
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Footer logo removed successfully',
        data: sanitizeSettings(updatedSettings)
      });
    } catch (error) {
      console.error('Remove footer logo error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to remove footer logo',
        error: error.message
      });
    }
  },

  // DELETE /settings/logo - Remove logo (reset to default)
  removeLogo: async (req, res) => {
    try {
      // Get current settings
      const currentSettings = await Settings.getSettings();
      const currentLogoUrl = currentSettings.logoUrl;

      // Reset to default logo
      const defaultLogoUrl = '/images/logo.png';
      const updatedSettings = await Settings.updateSettings({ logoUrl: defaultLogoUrl });

      // Remove current logo file if it's uploaded (not default)
      if (currentLogoUrl && currentLogoUrl !== defaultLogoUrl && currentLogoUrl.startsWith('/uploads/')) {
        try {
          const logoPath = localUploadPath(currentLogoUrl);
          if (!logoPath) throw new Error('not inside the uploads directory');
          await fs.access(logoPath); // Check if file exists
          await fs.unlink(logoPath); // Delete logo
          console.log('Logo file deleted:', logoPath);
        } catch (err) {
          console.log('Could not delete logo file:', err.message);
          // Don't fail the request if logo deletion fails
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Logo reset to default successfully',
        data: sanitizeSettings(updatedSettings)
      });
    } catch (error) {
      console.error('Remove logo error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to remove logo',
        error: error.message
      });
    }
  },

  // POST /settings/reset - Reset all settings to default
  resetSettings: async (req, res) => {
    try {
      // Get current settings to backup logo
      const currentSettings = await Settings.getSettings();
      const currentLogoUrl = currentSettings.logoUrl;

      // Create default settings
      const defaultSettings = {
        siteName: 'GymPilot',
        siteUrl: '',
        logoUrl: '/images/logo.png',
        timezone: 'UTC+05:00',
        dateFormat: 'MM/DD/YYYY',
        emailNotifications: true,
        marketingEmails: false,
        securityAlerts: true,
        twoFactorAuth: false,
        currency: 'USD',
        taxRate: 0,
        paymentMethods: ['credit_card', 'paypal'],
        topSliderText: '',
        youtubeUrl: '',
        facebookUrl: '',
        instagramUrl: '',
        twitterUrl: '',
        tiktokUrl: ''
      };

      // Update settings to default
      const resetSettings = await Settings.updateSettings(defaultSettings);

      // Remove uploaded logo if exists
      if (currentLogoUrl && currentLogoUrl !== '/images/logo.png' && currentLogoUrl.startsWith('/uploads/')) {
        try {
          const logoPath = localUploadPath(currentLogoUrl);
          if (!logoPath) throw new Error('not inside the uploads directory');
          await fs.access(logoPath);
          await fs.unlink(logoPath);
          console.log('Uploaded logo deleted during reset:', logoPath);
        } catch (err) {
          console.log('Could not delete uploaded logo during reset:', err.message);
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Settings reset to default successfully',
        data: sanitizeSettings(resetSettings)
      });
    } catch (error) {
      console.error('Reset settings error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to reset settings',
        error: error.message
      });
    }
  }
};

module.exports = settingsController;