// src/services/twoFactorService.js
//
// A second step at sign-in: a six-digit code emailed to the account. No
// authenticator app to install, which is what makes it usable at a gym
// whose receptionist changes every summer.
//
// It applies to anyone who has switched it on for themselves, and to every
// staff account when the gym has turned on "two-factor authentication" in
// Settings. Members signing in to book a class are not put through it
// unless they asked to be.

const crypto = require('crypto');
const User = require('../models/user');
const Settings = require('../models/settings');
const { sendEmail } = require('./emailService');
const { shell, paragraph, escapeHtml } = require('../templates/gymEmails');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function hashCode(challengeId, code) {
  return crypto.createHash('sha256').update(`${challengeId}:${code}`).digest('hex');
}

function isStaff(user) {
  return user.role !== 'user' || !!(user.employment && user.employment.isStaff);
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return email;
  const shown = name.length <= 2 ? name[0] || '' : name.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(1, name.length - shown.length))}@${domain}`;
}

/** Whether this account must complete the email step to sign in. */
async function required(user) {
  if (user.twoFactor && user.twoFactor.enabled) return true;
  if (!isStaff(user)) return false;
  const settings = await Settings.getSettings().catch(() => null);
  return !!(settings && settings.twoFactorAuth);
}

// The code goes by email, so an account this step can apply to needs an
// address to send it to. The Staff screen asks for one, but a member without
// one (a phone-only desk sign-up) could still be given a staff role from the
// Users tab -- and then, the day the gym requires two-factor, never sign in
// again. Checked wherever an account is given a role, whether or not the gym
// requires two-factor today: it can be switched on at any time.
const STAFF_NEED_EMAIL = 'This account has no email address, and staff need one: two-factor sign-in emails them a code. Ask them to add an email to their profile first.';

// What such an account is told at sign-in (one made before the rule above):
// only its owner can add an address, so they need to get in without the code.
const NO_EMAIL_SIGN_IN = 'Your sign-in code is sent by email, and this account has no email address. Ask an administrator to turn off two-factor sign-in while you sign in and add one to your profile.';

/** Whether `account`, as it will be after a change, must keep an email address. */
function needsEmail(account) {
  if (!account) return false;
  return isStaff(account) || !!(account.twoFactor && account.twoFactor.enabled);
}

/**
 * Creates a challenge for the user and emails the code. An account with no
 * email gets `noEmail` and no challenge: there is nowhere to send a code.
 */
async function startChallenge(user) {
  if (!user.email) return { challengeId: null, emailed: false, noEmail: true, error: NO_EMAIL_SIGN_IN };

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const challengeId = crypto.randomBytes(16).toString('hex');

  user.twoFactor = user.twoFactor || {};
  user.twoFactor.pending = {
    challengeId,
    codeHash: hashCode(challengeId, code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
    attempts: 0
  };
  await user.save();

  const { brand } = require('./gymNotifications');
  const b = await brand();
  const body = [
    paragraph(`Hi ${escapeHtml(user.firstName || 'there')}, here is your sign-in code:`),
    `<p style="margin:0 0 16px;font-size:32px;letter-spacing:0.3em;font-weight:700;color:#18181b">${code}</p>`,
    paragraph('It expires in 10 minutes. If you did not try to sign in, you can ignore this email — nobody can get in without the code.')
  ].join('');
  const result = await sendEmail(user.email, `${code} is your ${b.siteName} sign-in code`, shell(b.siteName, 'Your sign-in code', body));

  return { challengeId, emailed: !!result.success, error: result.success ? null : result.error };
}

/**
 * Checks a code. Returns the user on success; throws with `status` and a
 * message otherwise. A challenge is single-use and dies after five wrong
 * tries, so a six-digit code cannot be brute-forced.
 */
async function verify(challengeId, code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (!challengeId || clean.length !== 6) {
    const error = new Error('Enter the 6-digit code from your email');
    error.status = 400;
    throw error;
  }

  const user = await User.findOne({ 'twoFactor.pending.challengeId': String(challengeId) }).select('+twoFactor.pending.codeHash');
  const pending = user && user.twoFactor && user.twoFactor.pending;
  if (!user || !pending || !pending.codeHash) {
    const error = new Error('This sign-in has expired. Please sign in again.');
    error.status = 401;
    throw error;
  }

  const expired = !pending.expiresAt || new Date(pending.expiresAt) < new Date();
  const matches = crypto.timingSafeEqual(Buffer.from(pending.codeHash), Buffer.from(hashCode(challengeId, clean)));

  if (expired || pending.attempts >= MAX_ATTEMPTS || !matches) {
    if (expired || pending.attempts + 1 >= MAX_ATTEMPTS) {
      user.twoFactor.pending = null;
      await user.save();
      const error = new Error(expired ? 'That code has expired. Please sign in again.' : 'Too many wrong codes. Please sign in again.');
      error.status = 401;
      throw error;
    }
    user.twoFactor.pending.attempts = (pending.attempts || 0) + 1;
    await user.save();
    const error = new Error(`That code is not right. ${MAX_ATTEMPTS - user.twoFactor.pending.attempts} attempt(s) left.`);
    error.status = 401;
    throw error;
  }

  user.twoFactor.pending = null;
  await user.save();
  return user;
}

module.exports = {
  required,
  startChallenge,
  verify,
  maskEmail,
  isStaff,
  needsEmail,
  STAFF_NEED_EMAIL,
  NO_EMAIL_SIGN_IN,
  CODE_TTL_MS,
  MAX_ATTEMPTS
};
