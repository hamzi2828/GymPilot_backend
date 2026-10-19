// src/platform/controllers/platformSettingsController.js
//
// How gyms pay GymsPilotPro, managed from the panel rather than from a
// deploy: which way (services/payments -- bank transfer + receipt, Safepay,
// Stripe or none), the platform's own Stripe and Safepay keys, its bank
// accounts with their QR codes, and the reminders gym owners get. Secrets go
// in and are never handed back: what comes out is a masked preview and a
// flag saying whether something is stored.

const PlatformSettings = require('../models/platformSettingsModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const PlatformStripeEvent = require('../models/platformStripeEventModel');
const {
  getPlatformStripe,
  platformStripeConfig,
  forgetPlatformStripe,
  PlatformStripeNotConfiguredError
} = require('../services/platformStripe');
const { handlePlatformStripeEvent } = require('../services/platformWebhook');
const gateways = require('../services/payments');
const bankAccounts = require('../services/platformBankAccounts');
const { platformEmailConfigured } = require('../services/platformEmail');

const MASK_CHAR = '•';

function maskSecret(value) {
  if (!value) return '';
  const str = String(value);
  if (str.length <= 4) return MASK_CHAR.repeat(str.length);
  return MASK_CHAR.repeat(8) + str.slice(-4);
}

/** A value that came back from the UI untouched still carries the dots. */
function isMasked(value) {
  return typeof value === 'string' && value.includes(MASK_CHAR);
}

// How long a claimed event may sit unfinished before a redelivery may take
// it over. Far longer than any handler runs; a claim this old belongs to a
// request that died (killed, timed out) before it could release it.
const STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * Takes over an event whose claim was never finished. Deleting the stale
 * claim and claiming afresh keeps it atomic: of two retries racing here, one
 * deletes and claims, the other finds nothing to delete.
 */
async function reclaimStale(event, now = Date.now()) {
  const gone = await PlatformStripeEvent.deleteOne({
    eventId: event.id,
    handledAt: null,
    createdAt: { $lt: new Date(now - STALE_CLAIM_MS) }
  });
  if (!gone || gone.deletedCount !== 1) return false;
  return PlatformStripeEvent.claim(event);
}

/** This API's own address, built from the request, not guessed. */
function apiBase(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${req.get('host')}`;
}

/** What Stripe should send events to. */
function webhookUrl(req) {
  return gateways.getProvider('stripe').webhookUrl(apiBase(req));
}

const REMINDER_DEFAULTS = { daysBefore: [3], onDueDay: true, lastDayAfterDue: 3 };

/** The owner reminders as stored, with the defaults an unset field means. */
function remindersView(settings) {
  const r = (settings && settings.billingReminders) || {};
  return {
    daysBefore: Array.isArray(r.daysBefore) ? [...r.daysBefore] : [...REMINDER_DEFAULTS.daysBefore],
    onDueDay: r.onDueDay !== undefined && r.onDueDay !== null ? !!r.onDueDay : REMINDER_DEFAULTS.onDueDay,
    lastDayAfterDue: Number.isInteger(r.lastDayAfterDue) ? r.lastDayAfterDue : REMINDER_DEFAULTS.lastDayAfterDue
  };
}

function wholeDays(value, field) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (value === '' || value === null || !Number.isInteger(number) || number < 0 || number > 30) {
    return { problem: `${field} must be a whole number of days from 0 to 30` };
  }
  return { value: number };
}

/**
 * The reminders block, read strictly: what is sent replaces what is stored,
 * field by field; a value that cannot be used is a 400 naming the field.
 * @returns {{ value?: object, problem?: string }}
 */
function readReminders(incoming = {}, existing = {}) {
  const out = remindersView({ billingReminders: existing });
  if (incoming.daysBefore !== undefined) {
    if (!Array.isArray(incoming.daysBefore)) return { problem: 'billingReminders.daysBefore must be a list of days' };
    if (incoming.daysBefore.length > 10) return { problem: 'billingReminders.daysBefore can hold at most 10 days' };
    const days = [];
    for (const day of incoming.daysBefore) {
      const read = wholeDays(day, 'Each of billingReminders.daysBefore');
      if (read.problem) return read;
      days.push(read.value);
    }
    // Largest first: the order the reminders go out in.
    out.daysBefore = [...new Set(days)].sort((a, b) => b - a);
  }
  if (incoming.onDueDay !== undefined) out.onDueDay = incoming.onDueDay === true || incoming.onDueDay === 'true';
  if (incoming.lastDayAfterDue !== undefined) {
    const read = wholeDays(incoming.lastDayAfterDue, 'billingReminders.lastDayAfterDue');
    if (read.problem) return read;
    out.lastDayAfterDue = read.value;
  }
  return { value: out };
}

/**
 * A secret field as the panel sent it: the masked preview (or nothing)
 * keeps what is stored; anything else replaces it. A preview that came back
 * edited cannot be what was meant, so the stored value is kept and a
 * warning says so.
 */
function nextSecret(label, incoming, existing, warnings) {
  if (incoming === undefined) return { keep: true };
  if (!isMasked(incoming)) return { keep: false, value: String(incoming || '').trim() };
  if (incoming !== maskSecret(existing)) {
    warnings.push(`${label} was not changed because the masked value was edited. Clear the field and paste the whole value to replace it.`);
  }
  return { keep: true };
}

function clientIp(req) {
  return String(req.ip || (req.socket && req.socket.remoteAddress) || '');
}

function audit(req, action, meta) {
  return PlatformAuditLog.record({ actorId: req.superAdmin._id, actorEmail: req.superAdmin.email, action, meta, ip: clientIp(req) });
}

/** Every bank-account route answers with the whole list, as the panel shows it (and `bankAccount`, the one added). */
function bankAnswer(res, settings, status = 200, extra = {}, added = null) {
  return res.status(status).json({ success: true, ...extra, data: { bankAccounts: bankAccounts.accountsView(settings), ...(added ? { bankAccount: bankAccounts.accountView(added) } : {}) } });
}

function findAccount(settings, id) {
  return (settings.bankAccounts || []).find((account) => String(account._id) === String(id)) || null;
}

function view(settings, req) {
  const s = (settings && settings.stripe) || {};
  const sp = (settings && settings.safepay) || {};
  const choice = gateways.selectedFrom(settings);
  return {
    stripe: {
      enabled: !!s.enabled,
      publishableKey: s.publishableKey || '',
      secretKey: maskSecret(s.secretKey),
      webhookSecret: maskSecret(s.webhookSecret),
      secretKeySet: !!s.secretKey,
      webhookSecretSet: !!s.webhookSecret,
      // Whether these are test or live keys, from the key itself rather than
      // from what anyone typed.
      mode: s.secretKey ? (String(s.secretKey).startsWith('sk_live') ? 'live' : 'test') : '',
      accountName: s.accountName || '',
      accountId: s.accountId || '',
      livemode: !!s.livemode,
      checkedAt: s.checkedAt || null
    },
    webhookUrl: webhookUrl(req),
    onlinePayments: { provider: choice.id, providerChosen: choice.explicit },
    safepay: {
      enabled: !!sp.enabled,
      environment: sp.environment === 'production' ? 'production' : 'sandbox',
      publicKey: sp.publicKey || '',
      secretKey: maskSecret(sp.secretKey),
      webhookSecret: maskSecret(sp.webhookSecret),
      secretKeySet: !!sp.secretKey,
      webhookSecretSet: !!sp.webhookSecret,
      // Read-only: the address to register in Safepay's dashboard.
      webhook_url: gateways.getProvider('safepay').webhookUrl(apiBase(req))
    },
    bankAccounts: bankAccounts.accountsView(settings),
    billingReminders: remindersView(settings),
    // Whether the platform can send email at all (SMTP_* set): without it the
    // reminders to gym owners, and the approve / reject emails, are skipped.
    platform_email_configured: platformEmailConfigured(),
    updatedByEmail: settings.updatedByEmail || '',
    updatedAt: settings.updatedAt || null
  };
}

module.exports = {
  // GET /api/platform/settings
  get: async (req, res) => {
    try {
      const settings = await PlatformSettings.getSettings();
      return res.json({ success: true, data: view(settings, req) });
    } catch (error) {
      console.error('[platform] settings:', error);
      return res.status(500).json({ success: false, message: 'Could not load the settings' });
    }
  },

  // PUT /api/platform/settings
  //   { stripe?, onlinePayments?: { provider }, safepay?, billingReminders? }
  //
  // Each block optional; secrets sent back as their masked preview are kept.
  // Choosing a way (onlinePayments.provider) switches that gateway on:
  // Safepay is on exactly while it is the one chosen, and needs both keys
  // and the webhook secret for that (400 SECRET_REQUIRED, nothing saved);
  // choosing Stripe switches Stripe on, and choosing anything else never
  // switches it off -- gyms Stripe already bills go on being billed.
  update: async (req, res) => {
    try {
      const settings = await PlatformSettings.getSettings();
      const all = (req.body && typeof req.body === 'object' && req.body) || {};
      const body = (all.stripe && typeof all.stripe === 'object' && all.stripe) || {};
      const warnings = [];

      if (all.safepay && typeof all.safepay === 'object') {
        const incoming = all.safepay;
        if (incoming.environment !== undefined) {
          if (!['sandbox', 'production'].includes(incoming.environment)) {
            return res.status(400).json({ success: false, message: 'safepay.environment must be sandbox or production' });
          }
          settings.safepay.environment = incoming.environment;
        }
        if (incoming.publicKey !== undefined) settings.safepay.publicKey = String(incoming.publicKey || '').trim();
        for (const [field, label] of [['secretKey', 'The Safepay secret key'], ['webhookSecret', 'The Safepay webhook secret']]) {
          const next = nextSecret(label, incoming[field], settings.safepay[field], warnings);
          if (!next.keep) settings.safepay[field] = next.value;
        }
      }

      if (all.billingReminders && typeof all.billingReminders === 'object') {
        const read = readReminders(all.billingReminders, settings.billingReminders && settings.billingReminders.toObject ? settings.billingReminders.toObject() : settings.billingReminders);
        if (read.problem) return res.status(400).json({ success: false, message: read.problem });
        settings.billingReminders = read.value;
      }

      if (body.publishableKey !== undefined) settings.stripe.publishableKey = String(body.publishableKey || '').trim();
      // A field the user did not retype comes back masked; writing it through
      // would replace a real key with dots.
      if (body.secretKey !== undefined && !isMasked(body.secretKey)) {
        settings.stripe.secretKey = String(body.secretKey || '').trim();
      }
      if (body.webhookSecret !== undefined && !isMasked(body.webhookSecret)) {
        settings.stripe.webhookSecret = String(body.webhookSecret || '').trim();
      }
      if (body.enabled !== undefined) settings.stripe.enabled = !!body.enabled;

      // Whatever the last test found belongs to the old key.
      if (body.secretKey !== undefined && !isMasked(body.secretKey)) {
        settings.stripe.accountName = '';
        settings.stripe.accountId = '';
        settings.stripe.livemode = false;
        settings.stripe.checkedAt = null;
      }

      // How gyms pay. A platform that never chose reads as Stripe-or-none
      // (gateways.selectedFrom); the page sends that reading back on every
      // save, and storing it would pin a choice nobody made. So it is
      // stored once one has been made, or something else is chosen.
      const choosing = all.onlinePayments && typeof all.onlinePayments === 'object' && all.onlinePayments.provider !== undefined;
      if (choosing) {
        const wanted = String(all.onlinePayments.provider || 'none').trim();
        if (!gateways.CHOICES.includes(wanted)) {
          return res.status(400).json({ success: false, message: `onlinePayments.provider must be one of: ${gateways.CHOICES.join(', ')}` });
        }
        const stored = settings.onlinePayments && settings.onlinePayments.provider;
        const unchosen = gateways.selectedFrom({ stripe: { enabled: settings.stripe.enabled }, onlinePayments: {} });
        if (stored || wanted !== unchosen.id) settings.onlinePayments = { provider: wanted };
        settings.safepay.enabled = wanted === 'safepay';
        if (wanted === 'stripe') settings.stripe.enabled = true;
      }
      // Switched on, Safepay needs both keys and the webhook secret: without
      // the secret no payment would ever be recorded.
      if (settings.safepay.enabled) {
        const missing = [
          ['publicKey', 'the Safepay public key'],
          ['secretKey', 'the Safepay secret key'],
          ['webhookSecret', 'the Safepay webhook secret']
        ].find(([field]) => !settings.safepay[field]);
        if (missing) {
          return res.status(400).json({
            success: false,
            code: 'SECRET_REQUIRED',
            field: `safepay.${missing[0]}`,
            message: `To take payments through Safepay, enter ${missing[1]}. Nothing was saved.`
          });
        }
      }

      settings.updatedByEmail = req.superAdmin.email;
      await settings.save();
      forgetPlatformStripe();

      if (all.stripe) {
        PlatformAuditLog.record({
          actorId: req.superAdmin._id,
          actorEmail: req.superAdmin.email,
          action: 'platform_stripe_updated',
          meta: { enabled: settings.stripe.enabled, secretKeySet: !!settings.stripe.secretKey }
        });
      }
      if (choosing || all.safepay || all.billingReminders) {
        audit(req, 'platform_payments_updated', {
          provider: gateways.selectedFrom(settings).id,
          stripeEnabled: !!settings.stripe.enabled,
          safepayEnabled: !!settings.safepay.enabled,
          safepayEnvironment: settings.safepay.environment,
          safepaySecretKeySet: !!settings.safepay.secretKey,
          safepayWebhookSecretSet: !!settings.safepay.webhookSecret,
          billingReminders: remindersView(settings)
        });
      }

      return res.json({ success: true, message: 'Saved.', data: view(settings, req), ...(warnings.length ? { warnings } : {}) });
    } catch (error) {
      console.error('[platform] settings update:', error);
      return res.status(500).json({ success: false, message: error.message || 'Could not save the settings' });
    }
  },

  // POST /api/platform/settings/stripe/test
  //
  // Asks Stripe who these keys belong to. Anyone can type a key that looks
  // right; this is what proves it reaches the account you meant.
  testStripe: async (req, res) => {
    try {
      const typed = req.body && req.body.secretKey && !isMasked(req.body.secretKey) ? String(req.body.secretKey).trim() : '';
      const stripe = await getPlatformStripe(typed);
      const account = await stripe.accounts.retrieve();

      const name = account.settings?.dashboard?.display_name || account.business_profile?.name || account.email || account.id;

      // Remember what answered, but only when testing the saved key.
      if (!typed) {
        const settings = await PlatformSettings.getSettings();
        settings.stripe.accountName = name;
        settings.stripe.accountId = account.id;
        settings.stripe.livemode = !!account.charges_enabled && !String(settings.stripe.secretKey).startsWith('sk_test');
        settings.stripe.checkedAt = new Date();
        await settings.save();
      }

      return res.json({
        success: true,
        message: `Connected to ${name}.`,
        data: {
          accountId: account.id,
          accountName: name,
          country: account.country || '',
          defaultCurrency: (account.default_currency || '').toUpperCase(),
          chargesEnabled: !!account.charges_enabled,
          payoutsEnabled: !!account.payouts_enabled
        }
      });
    } catch (error) {
      if (error instanceof PlatformStripeNotConfiguredError) {
        return res.status(error.status).json({ success: false, message: error.message });
      }
      // Stripe's own message is the useful one here ("Invalid API Key
      // provided: sk_test_***"), so it is passed straight through.
      return res.status(400).json({ success: false, message: error.message || 'Stripe refused those keys' });
    }
  },

  // GET /api/platform/settings/payment-gateways
  //
  // Every way gyms can pay, its form fields, whether it is set up, and which
  // one is chosen -- the gym side's shape (GET /settings/payment-gateways),
  // so the Payments page draws its tiles and forms from it.
  paymentGateways: async (req, res) => {
    try {
      const { data, selected } = await gateways.describeProviders({ apiBase: apiBase(req) });
      return res.json({ success: true, data, selected });
    } catch (error) {
      console.error('[platform] payment gateways:', error);
      return res.status(500).json({ success: false, message: 'Could not load the payment gateways' });
    }
  },

  // POST /api/platform/settings/:gatewayId/test   { ...that gateway's fields }
  //
  // Checks the keys just typed -- or, for a field left as its masked
  // preview, the saved ones -- against the gateway. Stripe has its own
  // route above (it also remembers which account answered); this one
  // answers for it the same way.
  testGateway: async (req, res) => {
    try {
      const id = String((req.params && req.params.gatewayId) || '').toLowerCase();
      const provider = gateways.getProvider(id);
      if (!provider) return res.status(404).json({ success: false, message: `There is no payment gateway called "${id}".` });
      if (provider.id === 'stripe') return module.exports.testStripe(req, res);

      const body = (req.body && typeof req.body === 'object' && req.body) || {};
      const fields = provider.settingsKey && body[provider.settingsKey] && typeof body[provider.settingsKey] === 'object' ? body[provider.settingsKey] : body;
      const input = {};
      for (const field of provider.configFields) {
        const value = fields[field.name];
        if (value === undefined || value === null) continue;
        if (field.type === 'secret' && isMasked(value)) continue;
        input[field.name] = typeof value === 'string' ? value.trim() : value;
      }
      const result = await provider.testConnection(input, await PlatformSettings.getSettings());
      return res.status(result.success ? 200 : 400).json({ success: !!result.success, message: result.message, ...(result.data ? { data: result.data } : {}) });
    } catch (error) {
      return res.status(400).json({ success: false, message: (error && error.message) || 'The gateway could not be reached' });
    }
  },

  // POST /api/platform/settings/bank-accounts   { bankName, accountTitle, accountNumber?, iban?, active? }
  addBankAccount: async (req, res) => {
    try {
      const settings = await PlatformSettings.getSettings();
      if ((settings.bankAccounts || []).length >= bankAccounts.MAX_ACCOUNTS) {
        return res.status(400).json({ success: false, message: `At most ${bankAccounts.MAX_ACCOUNTS} bank accounts can be listed.` });
      }
      const read = bankAccounts.readAccount(req.body);
      if (read.problem) return res.status(400).json({ success: false, message: read.problem });
      settings.bankAccounts.push(read.value);
      settings.updatedByEmail = req.superAdmin.email;
      await settings.save();
      const added = settings.bankAccounts[settings.bankAccounts.length - 1];
      audit(req, 'platform_bank_account_added', { id: String(added._id), bankName: added.bankName, active: added.active });
      return bankAnswer(res, settings, 201, { message: 'Bank account added.' }, added);
    } catch (error) {
      console.error('[platform] bank account add:', error);
      return res.status(500).json({ success: false, message: 'Could not add the bank account' });
    }
  },

  // PUT /api/platform/settings/bank-accounts/:id   { any of the fields }
  updateBankAccount: async (req, res) => {
    try {
      const settings = await PlatformSettings.getSettings();
      const account = findAccount(settings, req.params.id);
      if (!account) return res.status(404).json({ success: false, message: 'That bank account is not on the list any more.' });
      const read = bankAccounts.readAccount(req.body, account.toObject ? account.toObject() : account);
      if (read.problem) return res.status(400).json({ success: false, message: read.problem });
      Object.assign(account, read.value);
      settings.updatedByEmail = req.superAdmin.email;
      await settings.save();
      audit(req, 'platform_bank_account_updated', { id: String(account._id), bankName: account.bankName, active: account.active });
      return bankAnswer(res, settings, 200, { message: 'Saved.' });
    } catch (error) {
      console.error('[platform] bank account update:', error);
      return res.status(500).json({ success: false, message: 'Could not save the bank account' });
    }
  },

  // DELETE /api/platform/settings/bank-accounts/:id
  removeBankAccount: async (req, res) => {
    try {
      const settings = await PlatformSettings.getSettings();
      const account = findAccount(settings, req.params.id);
      if (!account) return res.status(404).json({ success: false, message: 'That bank account is not on the list any more.' });
      const qr = account.qrCodeUrl;
      settings.bankAccounts = settings.bankAccounts.filter((a) => String(a._id) !== String(account._id));
      settings.updatedByEmail = req.superAdmin.email;
      await settings.save();
      await bankAccounts.removeQr(qr);
      audit(req, 'platform_bank_account_removed', { id: String(account._id), bankName: account.bankName });
      return bankAnswer(res, settings, 200, { message: 'Bank account removed.' });
    } catch (error) {
      console.error('[platform] bank account remove:', error);
      return res.status(500).json({ success: false, message: 'Could not remove the bank account' });
    }
  },

  // POST /api/platform/settings/bank-accounts/:id/qr   multipart `qrCode` (an image)
  //
  // The image a banking app scans (checked to be one: helper/upload.js
  // imageUploadChecked). Replaces the account's previous one, which is
  // removed from storage.
  uploadBankAccountQr: async (req, res) => {
    const file = req.file;
    try {
      if (!file) return res.status(400).json({ success: false, message: 'Choose the QR code image to upload (field qrCode).' });
      const settings = await PlatformSettings.getSettings();
      const account = findAccount(settings, req.params.id);
      if (!account) {
        bankAccounts.discardUpload(file);
        return res.status(404).json({ success: false, message: 'That bank account is not on the list any more.' });
      }
      const url = await bankAccounts.storeQr(file);
      const previous = account.qrCodeUrl;
      account.qrCodeUrl = url;
      settings.updatedByEmail = req.superAdmin.email;
      await settings.save();
      if (previous && previous !== url) await bankAccounts.removeQr(previous);
      audit(req, 'platform_bank_account_qr', { id: String(account._id), bankName: account.bankName, uploaded: true });
      return bankAnswer(res, settings, 200, { message: 'QR code uploaded.' });
    } catch (error) {
      bankAccounts.discardUpload(file);
      console.error('[platform] bank account QR:', error);
      return res.status(500).json({ success: false, message: error.message || 'Could not upload the QR code' });
    }
  },

  // DELETE /api/platform/settings/bank-accounts/:id/qr
  removeBankAccountQr: async (req, res) => {
    try {
      const settings = await PlatformSettings.getSettings();
      const account = findAccount(settings, req.params.id);
      if (!account) return res.status(404).json({ success: false, message: 'That bank account is not on the list any more.' });
      const previous = account.qrCodeUrl;
      account.qrCodeUrl = '';
      settings.updatedByEmail = req.superAdmin.email;
      await settings.save();
      await bankAccounts.removeQr(previous);
      audit(req, 'platform_bank_account_qr', { id: String(account._id), bankName: account.bankName, uploaded: false });
      return bankAnswer(res, settings, 200, { message: 'QR code removed.' });
    } catch (error) {
      console.error('[platform] bank account QR remove:', error);
      return res.status(500).json({ success: false, message: 'Could not remove the QR code' });
    }
  },

  // POST /api/platform/stripe/webhook  (public, raw body)
  //
  // Verified with the stored signing secret, applied to the gym it concerns
  // (services/platformWebhook.js), and written to the audit log, so "did
  // the webhook arrive, and what did it do?" is answered in the panel rather
  // than in Stripe's dashboard.
  //
  // Idempotent: the event id is claimed in platform_stripe_events before
  // anything is changed, so Stripe delivering the same event twice changes
  // a gym once. A handler that throws releases the claim and answers 500,
  // which is what makes Stripe try again later. A handler that never got to
  // release it (the function was killed mid-event) leaves a claim with no
  // handledAt; after STALE_CLAIM_MS a retry takes it over rather than being
  // told "duplicate" forever.
  webhook: async (req, res) => {
    try {
      const cfg = await platformStripeConfig();
      if (!cfg.webhookSecret) {
        return res.status(400).json({ success: false, message: 'No webhook signing secret is set for the platform' });
      }

      const signature = req.headers['stripe-signature'];
      let event;
      let stripe;
      try {
        stripe = await getPlatformStripe();
        event = stripe.webhooks.constructEvent(req.body, signature, cfg.webhookSecret);
      } catch (error) {
        console.error('[platform] webhook signature:', error.message);
        return res.status(400).json({ success: false, message: `Webhook signature failed: ${error.message}` });
      }

      const first = (await PlatformStripeEvent.claim(event)) || (await reclaimStale(event));
      if (!first) {
        // Already applied: acknowledged, and Stripe stops. Still being
        // applied by another delivery: a non-2xx, so Stripe comes back later
        // -- if that delivery dies mid-event, the retry after STALE_CLAIM_MS
        // takes the claim over instead of the event being lost as "duplicate".
        const claim = await PlatformStripeEvent.findOne({ eventId: event.id }).select('handledAt').lean();
        if (claim && !claim.handledAt) {
          return res.status(409).json({ received: false, duplicate: true, inProgress: true, message: 'This event is still being handled; retry later.' });
        }
        return res.json({ received: true, duplicate: true });
      }

      let outcome;
      try {
        outcome = await handlePlatformStripeEvent(event, stripe);
      } catch (error) {
        await PlatformStripeEvent.release(event);
        console.error(`[platform] webhook ${event.type} (${event.id}) failed:`, error);
        PlatformAuditLog.record({
          actorId: null,
          actorEmail: 'stripe',
          action: 'platform_stripe_event',
          meta: { type: event.type, id: event.id, livemode: !!event.livemode, result: `failed: ${error.message}` }
        });
        return res.status(500).json({ success: false, message: 'Webhook handler failed' });
      }

      await PlatformStripeEvent.markHandled(event, { gym: outcome.gym, result: outcome.result });
      PlatformAuditLog.record({
        actorId: null,
        actorEmail: 'stripe',
        action: 'platform_stripe_event',
        gymId: outcome.gym ? outcome.gym._id : null,
        gymSlug: outcome.gym ? outcome.gym.slug : '',
        meta: { type: event.type, id: event.id, livemode: !!event.livemode, result: outcome.result }
      });

      // Acknowledged whatever it was: an unhandled event is not an error, and
      // a non-200 makes Stripe retry it for days.
      return res.json({ received: true, result: outcome.result });
    } catch (error) {
      console.error('[platform] webhook:', error);
      return res.status(500).json({ success: false, message: 'Webhook failed' });
    }
  },

  // exported for tests
  reclaimStale,
  STALE_CLAIM_MS,
  maskSecret,
  readReminders,
  remindersView
};
