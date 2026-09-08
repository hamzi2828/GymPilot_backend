// src/services/branding.js
//
// What a gym looks like, in one small payload: its name, its logo and the
// colours it chose. The website reads these from the same settings document
// at build and render time; the phone app has no such luxury, so it asks for
// this once at sign-in and paints itself with it.

const Settings = require('../models/settings');
const { themeFor } = require('../config/themes');
const { currentTenant, frontendOrigin } = require('../platform/tenantContext');

/**
 * A logo path that a phone can actually load.
 *
 * Uploaded logos already live on blob storage and are absolute, so they pass
 * straight through. A relative path -- the default '/images/logo.png', and
 * anything else typed into Settings -- is served by the gym's OWN website and
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
 * @param {string} apiOrigin e.g. https://api.gympilot.app — used to make
 *                           relative logo paths loadable off-site.
 */
async function branding(apiOrigin = '') {
  const settings = await Settings.getSettings();
  const gym = currentTenant();
  const theme = themeFor(settings.theme);

  return {
    gym: gym ? { slug: gym.slug, name: gym.name } : null,
    siteName: settings.siteName || (gym && gym.name) || 'GymPilot',
    logoUrl: absoluteAsset(settings.logoUrl, siteOrigin(), settings.siteUrl, apiOrigin),
    logoWidth: settings.logoWidth || 160,
    logoHeight: settings.logoHeight || 56,
    theme: theme.key,
    themeName: theme.name,
    // The six colours the app paints itself with.
    themeTokens: theme.tokens,
    currency: settings.currency || 'USD',
    locale: settings.locale || { language: 'en', direction: 'ltr' },
    contact: {
      email: settings.contactEmail || '',
      phone: settings.contactPhone || settings.mobileNumber || '',
      address: settings.address || ''
    },
    openingHours: settings.openingHours || [],
    whatsapp: settings.messaging?.whatsappButton?.enabled ? settings.messaging.whatsappButton.number || '' : ''
  };
}

module.exports = { branding, absoluteAsset };
