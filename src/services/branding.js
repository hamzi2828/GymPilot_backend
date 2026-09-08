// src/services/branding.js
//
// What a gym looks like, in one small payload: its name, its logo and the
// colours it chose. The website reads these from the same settings document
// at build and render time; the phone app has no such luxury, so it asks for
// this once at sign-in and paints itself with it.

const Settings = require('../models/settings');
const { themeFor } = require('../config/themes');
const { currentTenant } = require('../platform/tenantContext');

/**
 * A logo path that a phone can actually load. Uploaded logos already live on
 * blob storage (absolute); anything still relative is resolved against this
 * API, which is the only origin the app is configured with.
 */
function absoluteAsset(url, apiOrigin) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${String(apiOrigin || '').replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
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
    logoUrl: absoluteAsset(settings.logoUrl, apiOrigin),
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
