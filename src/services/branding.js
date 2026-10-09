// src/services/branding.js
//
// What a gym looks like, in one small payload: its name, its logo and the
// colours it chose. The website reads these from the same settings document
// at build and render time; the phone app has no such luxury, so it asks for
// this once at sign-in and paints itself with it.

const Settings = require('../models/settings');
const { themeFor } = require('../config/themes');
const { currentTenant, frontendOrigin } = require('../platform/tenantContext');

// What a settings row made before logos defaulted to none holds for a gym
// that never uploaded one: a bundled picture of the word "LOGO" on the
// website. It is not the gym's, so it counts as no logo -- the app and the
// receipts then show the gym's name, as they do for an empty one.
const PLACEHOLDER_LOGO = '/images/logo.png';

/** The gym's own logo, or '' when it has none. */
function ownLogo(url) {
  const value = String(url || '').trim();
  return value === PLACEHOLDER_LOGO ? '' : value;
}

/**
 * A logo path that a phone can actually load.
 *
 * Uploaded logos already live on blob storage and are absolute, so they pass
 * straight through. A relative path -- anything typed into Settings -- is
 * served by the gym's OWN website and
 * not by this API, so it is resolved against the first origin offered that is
 * actually set: the gym's registered domain, then whatever siteUrl Settings
 * carries, and only then this API. The registered domain leads because it is
 * the platform's own record of where the gym lives, while siteUrl is a field
 * an operator typed once and may never have revisited.
 */
function absoluteAsset(url, ...origins) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const base = origins.map((o) => String(o || '').trim().replace(/\/+$/, '')).find(Boolean);
  if (!base) return value;
  return `${base}/${value.replace(/^\/+/, '')}`;
}

/** Where the gym's website lives, which is where its relative assets are. */
function siteOrigin() {
  try {
    return frontendOrigin();
  } catch {
    // No gym in context (a platform-level call): there is no website to
    // resolve against, so the caller's own fallback is used instead.
    return '';
  }
}

/**
 * An address a member can write to: the contact email from Settings →
 * General → Business. Without one, the address the gym's emails are sent
 * FROM, which is where a reply to any of them lands anyway -- unless it is a
 * no-reply address, in which case there is nothing to offer.
 */
function supportEmail(settings) {
  const candidates = [settings.contactEmail, settings.smtp && settings.smtp.fromEmail];
  const value = candidates.map((c) => String(c || '').trim()).find(Boolean) || '';
  return /^no-?reply/i.test(value) ? '' : value;
}

/**
 * @param {string} apiOrigin e.g. https://api.gympilot.app — used to make
 *                           relative logo paths loadable off-site.
 */
async function branding(apiOrigin = '') {
  const settings = await Settings.getSettings();
  const gym = currentTenant();
  const theme = themeFor(settings.theme);
  const site = siteOrigin();
  const email = supportEmail(settings);
  const phone = settings.mobileNumber || '';

  return {
    gym: gym ? { slug: gym.slug, name: gym.name } : null,
    siteName: settings.siteName || (gym && gym.name) || 'GymPilot',
    // Where the gym's website lives, for the things the app hands over to
    // it: buying or changing a plan, invoices, the password reset link. The
    // registered domain first; failing that, whatever Settings says.
    siteUrl: site || String(settings.siteUrl || '').trim().replace(/\/+$/, ''),
    logoUrl: absoluteAsset(ownLogo(settings.logoUrl), site, settings.siteUrl, apiOrigin),
    logoWidth: settings.logoWidth || 160,
    logoHeight: settings.logoHeight || 56,
    theme: theme.key,
    themeName: theme.name,
    // The six colours the app paints itself with.
    themeTokens: theme.tokens,
    currency: settings.currency || 'USD',
    locale: settings.locale || { language: 'en', direction: 'ltr' },
    // How to reach the gym, twice over: the nested shape the app has always
    // read, and the two flat fields for anything that only wants a way in.
    supportEmail: email,
    phone,
    contact: {
      email,
      phone,
      address: settings.address || ''
    },
    openingHours: settings.openingHours || [],
    whatsapp: settings.messaging?.whatsappButton?.enabled ? settings.messaging.whatsappButton.number || '' : ''
  };
}

module.exports = { branding, absoluteAsset, ownLogo, PLACEHOLDER_LOGO };
