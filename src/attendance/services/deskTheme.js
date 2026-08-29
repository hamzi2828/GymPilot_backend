// src/attendance/services/deskTheme.js
//
// Resolves the site colour scheme chosen in Settings into a palette the
// desktop app can paint itself with, so the front desk wears whatever brand
// the website is currently wearing.
//
// KEEP IN SYNC with GymPilot_frontend/src/theme/themes.ts. The two are
// separate deployables with no shared package, so the presets are duplicated
// on purpose rather than imported. The `key` values are what tie them
// together, and Settings.theme stores one of them; a preset added there and
// not here simply falls back to the default, it does not break.
//
// Only the accent tokens travel. The site is a dark-on-black design; the
// desktop app is a light one, read across a counter under fluorescent light,
// and inverting it to match would make it harder to use rather than more
// on-brand. The accent is what actually reads as the brand, and the app
// adapts it for a white surface on its own (see BrandTheme.cs).

const Settings = require('../../models/settings');

const DEFAULT_KEY = 'electric-lime';

const THEMES = {
  'midnight-ember': {
    name: 'Midnight Ember',
    accent: '#ff6b2c', accentDark: '#c74e1b', accentSoft: '#ffb894', onAccent: '#0e0e10'
  },
  'graphite-mono': {
    name: 'Graphite Mono',
    accent: '#f5f5f7', accentDark: '#c9c9cf', accentSoft: '#4a4a52', onAccent: '#0b0b0d'
  },
  'arctic-steel': {
    name: 'Arctic Steel',
    accent: '#38bdf8', accentDark: '#0284c7', accentSoft: '#bae6fd', onAccent: '#04121f'
  },
  'crimson-iron': {
    name: 'Crimson Iron',
    accent: '#e11d48', accentDark: '#9f1239', accentSoft: '#fda4af', onAccent: '#ffffff'
  },
  'electric-lime': {
    name: 'Electric Lime',
    accent: '#bee304', accentDark: '#6c8704', accentSoft: '#e8f7a0', onAccent: '#0a0a0a'
  },
  'royal-violet': {
    name: 'Royal Violet',
    accent: '#8b5cf6', accentDark: '#6d28d9', accentSoft: '#ddd6fe', onAccent: '#ffffff'
  },
  'emerald-forge': {
    name: 'Emerald Forge',
    accent: '#10b981', accentDark: '#047857', accentSoft: '#a7f3d0', onAccent: '#04140e'
  },
  'solar-amber': {
    name: 'Solar Amber',
    accent: '#f5a524', accentDark: '#b45309', accentSoft: '#fde68a', onAccent: '#1a1206'
  },
};

function paletteFor(key) {
  const chosen = THEMES[key] || THEMES[DEFAULT_KEY];
  return {
    key: THEMES[key] ? key : DEFAULT_KEY,
    name: chosen.name,
    accent: chosen.accent,
    accent_dark: chosen.accentDark,
    accent_soft: chosen.accentSoft,
    on_accent: chosen.onAccent
  };
}

// A theme lookup must never be the reason a desk cannot sign in or record a
// punch, so a missing settings document or a database hiccup falls back to
// the default palette rather than propagating.
async function currentPalette() {
  try {
    const settings = await Settings.findOne({ isActive: true }).select('theme siteName').lean();
    const palette = paletteFor(settings && settings.theme);
    if (settings && settings.siteName) palette.site_name = settings.siteName;
    return palette;
  } catch (err) {
    console.error('[attendance] could not read the site theme:', err.message);
    return paletteFor(DEFAULT_KEY);
  }
}

module.exports = { currentPalette, paletteFor, DEFAULT_KEY };
