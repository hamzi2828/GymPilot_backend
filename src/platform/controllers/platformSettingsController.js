// src/platform/controllers/platformSettingsController.js
//
// The platform's own Stripe keys, managed from the panel rather than from a
// deploy. Secrets go in and are never handed back: what comes out is a masked
// preview and a flag saying whether something is stored.

const PlatformSettings = require('../models/platformSettingsModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const {
  getPlatformStripe,
  platformStripeConfig,
  forgetPlatformStripe,
  PlatformStripeNotConfiguredError
} = require('../services/platformStripe');

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

/** What Stripe should send events to. Built from the request, not guessed. */
function webhookUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${req.get('host')}/api/platform/stripe/webhook`;
}

function view(settings, req) {
  const s = (settings && settings.stripe) || {};
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
  update: async (req, res) => {
    try {
      const settings = await PlatformSettings.getSettings();
      const body = (req.body && req.body.stripe) || {};

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

      settings.updatedByEmail = req.superAdmin.email;
      await settings.save();
      forgetPlatformStripe();

      PlatformAuditLog.record({
        actorId: req.superAdmin._id,
        actorEmail: req.superAdmin.email,
        action: 'platform_stripe_updated',
        meta: { enabled: settings.stripe.enabled, secretKeySet: !!settings.stripe.secretKey }
      });

      return res.json({ success: true, message: 'Saved.', data: view(settings, req) });
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

  // POST /api/platform/stripe/webhook  (public, raw body)
  //
  // Verified with the stored signing secret and written to the audit log, so
  // "did the webhook arrive?" is answered in the panel rather than in Stripe's
  // dashboard. Nothing acts on the events yet.
  webhook: async (req, res) => {
    try {
      const cfg = await platformStripeConfig();
      if (!cfg.webhookSecret) {
        return res.status(400).json({ success: false, message: 'No webhook signing secret is set for the platform' });
      }

      const signature = req.headers['stripe-signature'];
      let event;
      try {
        const stripe = await getPlatformStripe();
        event = stripe.webhooks.constructEvent(req.body, signature, cfg.webhookSecret);
      } catch (error) {
        console.error('[platform] webhook signature:', error.message);
        return res.status(400).json({ success: false, message: `Webhook signature failed: ${error.message}` });
      }

      PlatformAuditLog.record({
        actorId: null,
        actorEmail: 'stripe',
        action: 'platform_stripe_event',
        meta: { type: event.type, id: event.id, livemode: !!event.livemode }
      });

      // Acknowledged whatever it was: an unhandled event is not an error, and
      // a non-200 makes Stripe retry it for days.
      return res.json({ received: true });
    } catch (error) {
      console.error('[platform] webhook:', error);
      return res.status(500).json({ success: false, message: 'Webhook failed' });
    }
  }
};
