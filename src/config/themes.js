// src/config/themes.js
//
// The colour schemes a gym can pick under Settings → Colour Scheme. The
// website has its own copy in `GymPilot_frontend/src/theme/themes.ts` because
// it needs them at build time; this one is served to anything that cannot
// read that file -- the phone app, most of all. **Keep the two in step**: a
// scheme added there and not here leaves the app on the default colours.
//
// Six tokens per scheme, the same six the website uses:
//   accent      the one bright colour: buttons, links, the active tab
//   accentDark  a pressed / hovered accent
//   accentSoft  a pale accent for tints and badges
//   onAccent    text that sits on top of the accent and stays readable
//   base        the page behind everything
//   surface     a card or bar lifted off the base

const THEMES = [
  { key: 'midnight-ember', name: 'Midnight Ember', tokens: { accent: '#ff6b2c', accentDark: '#c74e1b', accentSoft: '#ffb894', onAccent: '#0e0e10', base: '#0e0e10', surface: '#1a1a1e' } },
  { key: 'graphite-mono', name: 'Graphite Mono', tokens: { accent: '#f5f5f7', accentDark: '#c9c9cf', accentSoft: '#4a4a52', onAccent: '#0b0b0d', base: '#0b0b0d', surface: '#17171a' } },
  { key: 'arctic-steel', name: 'Arctic Steel', tokens: { accent: '#38bdf8', accentDark: '#0284c7', accentSoft: '#bae6fd', onAccent: '#04121f', base: '#0a0f1c', surface: '#141b2d' } },
  { key: 'crimson-iron', name: 'Crimson Iron', tokens: { accent: '#e11d48', accentDark: '#9f1239', accentSoft: '#fda4af', onAccent: '#ffffff', base: '#09090b', surface: '#18181b' } },
  { key: 'electric-lime', name: 'Electric Lime', tokens: { accent: '#bee304', accentDark: '#6c8704', accentSoft: '#e8f7a0', onAccent: '#0a0a0a', base: '#000000', surface: '#141414' } },
  { key: 'royal-violet', name: 'Royal Violet', tokens: { accent: '#8b5cf6', accentDark: '#6d28d9', accentSoft: '#ddd6fe', onAccent: '#ffffff', base: '#0b0a12', surface: '#17151f' } },
  { key: 'emerald-forge', name: 'Emerald Forge', tokens: { accent: '#10b981', accentDark: '#047857', accentSoft: '#a7f3d0', onAccent: '#04140e', base: '#0a100d', surface: '#151d19' } },
  { key: 'solar-amber', name: 'Solar Amber', tokens: { accent: '#f5a524', accentDark: '#b45309', accentSoft: '#fde68a', onAccent: '#1a1206', base: '#12100e', surface: '#1f1b16' } }
];

const DEFAULT_THEME_KEY = 'electric-lime';

/** The named scheme, or the default when the key is unknown or missing. */
function themeFor(key) {
  return THEMES.find((t) => t.key === key) || THEMES.find((t) => t.key === DEFAULT_THEME_KEY) || THEMES[0];
}

module.exports = { THEMES, DEFAULT_THEME_KEY, themeFor };
