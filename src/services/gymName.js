// src/services/gymName.js
//
// The gym's name, for email subjects, the sender line and any copy that
// addresses the member. Every gym on the platform has its own Settings
// document, so the answer is whatever Settings → General says for the gym in
// context -- never a value from the environment, which would name every
// gym's email after the first gym. The env value remains only as the
// fallback a single-gym deployment used before the platform existed.

const Settings = require('../models/settings');

const DEFAULT_SITE_NAME = 'GymsPilotPro';

async function gymSiteName() {
  try {
    const settings = await Settings.getSettings();
    const name = settings && String(settings.siteName || '').trim();
    if (name) return name;
  } catch {
    // No database, or no gym in context (a script, a cold start): fall back
    // rather than fail -- an email with a generic name beats no email.
  }
  return process.env.SITE_NAME || DEFAULT_SITE_NAME;
}

module.exports = { gymSiteName, DEFAULT_SITE_NAME };
