// src/platform/ownerInvite.js
//
// The email a gym's owner gets when their gym is ready (and again when
// support re-sends it): the gym's name, where to sign in, which address to
// use, and a link that lets them SET a password -- never the password itself.
//
// The link is the same single-use, hashed reset token the site's own
// forgot-password flow issues (see controller/userController.js forgotPassword
// and the User model's passwordResetTokenHash / passwordResetExpiresAt): only
// the SHA-256 of the token is stored, the raw token goes in the email and is
// forgotten, and /authentication?mode=reset consumes it once. It is longer
// lived than a forgot-password link because an owner opens a welcome email
// when they get round to it, not within the hour.
//
// Everything here that touches the User model must run INSIDE the gym's
// tenant context (runWithTenant); the caller is responsible for that.

const crypto = require('crypto');
const User = require('../models/user');
const { sendEmail } = require('../services/emailService');
const { shell, paragraph, button, detailTable, escapeHtml } = require('../templates/gymEmails');

const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymsPilotPro';
const INVITE_TTL_HOURS = Math.max(1, Number(process.env.OWNER_INVITE_TTL_HOURS) || 72);

/** Same hashing as userController.hashResetToken -- the reset endpoint compares against this. */
function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** The address forgot-password links point at, with the same query shape. */
function setPasswordLink(siteUrl, token, email) {
  const base = String(siteUrl || '').replace(/\/+$/, '');
  return `${base}/authentication?mode=reset&token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
}

function ownerInviteEmail({ gymName, email, siteUrl, link, firstName, resend, validHours }) {
  const signIn = `${String(siteUrl || '').replace(/\/+$/, '')}/authentication`;
  const body = [
    paragraph(
      resend
        ? `Hi ${escapeHtml(firstName || 'there')}, here is a fresh link to set the password for your ${escapeHtml(PLATFORM_NAME)} admin account.`
        : `Hi ${escapeHtml(firstName || 'there')}, ${escapeHtml(gymName)} is set up on ${escapeHtml(PLATFORM_NAME)}. Choose a password and you can sign in straight away.`
    ),
    detailTable([
      ['Gym', gymName],
      ['Sign in at', signIn],
      ['Your email', email]
    ]),
    button(link, 'Set my password'),
    paragraph(
      `<span style="display:block;margin-top:20px;font-size:13px;color:#71717a">This link works once and for ${validHours} hours. After that, use “Forgot password” on the sign-in page to get another.</span>`
    ),
    paragraph(
      `<span style="font-size:13px;color:#71717a">If the button does not work, paste this into your browser:<br><span style="word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px">${escapeHtml(link)}</span></span>`
    )
  ].join('');

  return {
    subject: resend ? `Set your ${gymName} admin password` : `${gymName} is ready on ${PLATFORM_NAME}`,
    html: shell(PLATFORM_NAME, resend ? 'Set your password' : `Welcome to ${PLATFORM_NAME}`, body, `You are receiving this because ${escapeHtml(gymName)} was set up on ${escapeHtml(PLATFORM_NAME)} with this address as its owner.`)
  };
}

/**
 * Issues a set-password token for the administrator at `email` and emails
 * them the link. Never throws for a delivery problem: the answer says
 * whether it went.
 *
 * @param {object} args
 * @param {object} args.gym       the gym (name is all that is read)
 * @param {string} args.email     the owner's address inside the gym
 * @param {string} args.siteUrl   the gym's website origin
 * @param {boolean} [args.resend] true from "resend invite" -- changes the wording only
 * @param {boolean} [args.handOverLink] when the email does not go, keep the
 *   link working and return it as `link`, for a super admin to pass on by
 *   hand. Only for an answer to that super admin: never logged, never stored.
 * @returns {Promise<{sent: boolean, error?: string, link?: string}>}
 */
async function sendOwnerInvite({ gym, email, siteUrl, resend = false, handOverLink = false }) {
  const address = String(email || '').toLowerCase().trim();
  if (!address) return { sent: false, error: 'No owner email' };

  const user = await User.findOne({ email: address });
  if (!user) return { sent: false, error: `No administrator with the address ${address} exists in this gym` };

  const token = crypto.randomBytes(32).toString('hex');
  user.passwordResetTokenHash = hashResetToken(token);
  user.passwordResetExpiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);
  await user.save();

  const link = setPasswordLink(siteUrl, token, address);
  const { subject, html } = ownerInviteEmail({
    gymName: gym.name,
    email: address,
    siteUrl,
    link,
    firstName: user.firstName,
    resend,
    validHours: INVITE_TTL_HOURS
  });

  let result;
  try {
    result = await sendEmail(address, subject, html);
  } catch (error) {
    result = { success: false, error: error.message };
  }

  if (!result || !result.success) {
    const reason = (result && result.error) || 'email could not be sent';
    // The reason only: the link opens the owner's account.
    console.error(`[platform] owner invite to ${address} failed: ${reason}`);
    // Handed to the super admin who asked, the link has somebody to receive
    // it after all. Otherwise a live token nobody received is only a
    // liability; clear it, as forgot-password does, and say so.
    if (handOverLink) return { sent: false, error: reason, link };
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save().catch(() => {});
    return { sent: false, error: reason };
  }

  return { sent: true };
}

module.exports = { sendOwnerInvite, setPasswordLink, ownerInviteEmail, hashResetToken, INVITE_TTL_HOURS };
