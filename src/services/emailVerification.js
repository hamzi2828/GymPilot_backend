// src/services/emailVerification.js
//
// "Is this address really theirs?"
//
// Sign-up takes any address and a member may change theirs, and nothing
// checked either. That was harmless until a matching address started to
// decide ownership: a guest who paid for a membership before making an
// account is recognised at the door, in the booking screen and in their data
// export by the address on the order. So anyone could register a guest
// buyer's address and walk in on what they paid for.
//
// The rule now: an address claims those orders only once somebody has shown
// it is theirs (user.emailVerified is not false). What counts:
//
//   * opening the link in the "confirm your email" message sent here;
//   * a Google sign-in, which hands over an address Google has checked;
//   * a right sign-in code, or a password reset, that was emailed to it;
//   * staff making or importing the account, or saying so afterwards for a
//     member standing at the desk (POST /admin/users/:id/verify-email) --
//     they vouch for it.
//
// A self-service sign-up or change of address starts unproven and is sent
// the link. Nothing else about the account waits on it: it signs in, books
// and pays as before, and everything filed under its own id is untouched.
// Accounts from before the flag have no value and count as proven, so
// nobody was cut off when it arrived.
//
// The link is kept the way the reset link is (userController): a random
// token in the email, only its SHA-256 hash stored, an expiry, single use.

const crypto = require('crypto');
const User = require('../models/user');
const { sendEmail } = require('./emailService');
const { gymSiteName } = require('./gymName');
const { shell, paragraph, button, escapeHtml } = require('../templates/gymEmails');
const { currentTenantSlug } = require('../platform/tenantContext');

// Long enough to be opened at the weekend; the link does one thing, and
// only for the account that asked for it.
const VERIFY_TOKEN_TTL_DAYS = 7;

const LINK_INVALID = 'This confirmation link is invalid or has expired. Sign in and ask for a new one from your account page.';

// One address, and nothing that would make a mail server read it as two.
function looksLikeEmail(value) {
  return typeof value === 'string' && /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(value);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Whether the account's address has been shown to be theirs. Only an
 * explicit `false` says no: an account from before the flag has no value.
 *
 * Mind a projection: an object loaded without `emailVerified` reads as
 * proven here, so a caller holding one asks the database (unprovenIds).
 */
function emailIsVerified(account) {
  return !!account && account.emailVerified !== false;
}

/**
 * Of `accounts`, the ids (as strings) whose address is not proven. The flag
 * is read from the account where it is there, and from the database for the
 * ones handed over without it -- a lean projection that never asked for it
 * must not pass for proven. One query at most, however many accounts.
 */
async function unprovenIds(accounts) {
  const unproven = new Set();
  const unknown = [];
  for (const account of accounts || []) {
    if (!account || !account.email) continue;
    if (account.emailVerified === false) unproven.add(String(account._id));
    else if (account.emailVerified === undefined) unknown.push(account._id);
  }
  if (unknown.length) {
    const rows = await User.find({ _id: { $in: unknown }, emailVerified: false }).select('_id').lean();
    for (const row of rows) unproven.add(String(row._id));
  }
  return unproven;
}

/**
 * Where the link in the email points: this API, which has to be reachable at
 * the address the request came in on. API_PUBLIC_URL pins it for a server
 * that sits behind something which passes any Host header through.
 */
function apiOrigin(req) {
  const fixed = String(process.env.API_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (fixed) return fixed;
  return req && typeof req.get === 'function' && req.get('host') ? `${req.protocol || 'https'}://${req.get('host')}` : '';
}

function confirmationEmail({ firstName, siteName, url }) {
  const body = [
    paragraph(`Hi ${escapeHtml(firstName || 'there')}, please confirm that this is your email address.`),
    `<p style="margin:0 0 20px">${button(url, 'Confirm my email')}</p>`,
    paragraph(
      `Why we ask: once it is confirmed, anything bought from ${escapeHtml(siteName)} with this address shows up on your account, and nobody else can claim it by typing your address.`
    ),
    paragraph(
      `The link works for ${VERIFY_TOKEN_TTL_DAYS} days. If you did not create an account or change your email at ${escapeHtml(siteName)}, ignore this email and nothing will happen.`
    )
  ].join('');
  return { subject: `Confirm your email for ${siteName}`, html: shell(siteName, 'Confirm your email address', body) };
}

/**
 * Stores a fresh token on the account and emails the link to its address.
 * The token is written only while the account still has that address and
 * has not proven it, so a link can never end up proving an address it was
 * not sent to. Never throws: a send that fails is logged, its token removed,
 * and the account simply stays unproven.
 *
 * @returns {Promise<{ sent: boolean, error?: string }>}
 */
async function sendLink(account, { origin } = {}) {
  try {
    const email = account && account.email;
    if (!email || !origin) return { sent: false, error: email ? 'No address for the link' : 'No email address' };

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const stored = await User.updateOne(
      { _id: account._id, email, emailVerified: false },
      { $set: { emailVerifyTokenHash: tokenHash, emailVerifyExpiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_DAYS * 24 * 3600 * 1000) } }
    );
    if (!stored.matchedCount) return { sent: false, error: 'Nothing to confirm' };

    const slug = currentTenantSlug();
    const url = `${origin}/user/verify-email?token=${token}${slug ? `&tenant=${encodeURIComponent(slug)}` : ''}`;
    const built = confirmationEmail({ firstName: account.firstName, siteName: await gymSiteName(), url });
    const result = await sendEmail(email, built.subject, built.html);
    if (result.success) return { sent: true };

    // A link nobody received must not sit valid for days.
    console.error('[auth] confirmation email failed for', email, '-', result.error);
    await User.updateOne({ _id: account._id, emailVerifyTokenHash: tokenHash }, { $set: { emailVerifyTokenHash: null, emailVerifyExpiresAt: null } });
    return { sent: false, error: result.error };
  } catch (error) {
    console.error('[auth] could not send a confirmation link:', error.message);
    return { sent: false, error: error.message };
  }
}

function liveToken(token) {
  return {
    emailVerifyTokenHash: hashToken(token),
    emailVerifyExpiresAt: { $gt: new Date() },
    email: { $type: 'string' }
  };
}

/** The account a link is for, without spending it; null when it is not good. */
async function pending(token) {
  if (!token || typeof token !== 'string') return null;
  return User.findOne(liveToken(token)).select('firstName email').lean();
}

/**
 * Spends a link: the account's address is proven and the token is gone, in
 * one write, so two clicks cannot both use it. Null when it is not good.
 */
async function confirm(token) {
  if (!token || typeof token !== 'string') return null;
  return User.findOneAndUpdate(
    liveToken(token),
    { $set: { emailVerified: true, emailVerifyTokenHash: null, emailVerifyExpiresAt: null } },
    { new: true }
  ).select('firstName email');
}

/**
 * Marks an address proven by something other than the link -- a sign-in code
 * or a reset link that was emailed to it. Conditional on the address, so
 * proof of one address never lands on another. Never throws.
 */
async function markVerified(userId, email) {
  if (!userId || !email) return false;
  try {
    const result = await User.updateOne(
      { _id: userId, email, emailVerified: false },
      { $set: { emailVerified: true, emailVerifyTokenHash: null, emailVerifyExpiresAt: null } }
    );
    return !!result.modifiedCount;
  } catch (error) {
    console.error('[auth] could not mark', String(userId), 'as confirmed:', error.message);
    return false;
  }
}

// The two pages the link shows. The link itself changes nothing: mail
// scanners open every link in a message, and one of those must not be able
// to confirm an address for whoever typed it. The person presses the button.
function pageShell(siteName, title, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
  <div style="max-width:440px;margin:48px auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:28px">
    <p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#71717a">${escapeHtml(siteName)}</p>
    <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${escapeHtml(title)}</h1>
    ${inner}
  </div>
</body>
</html>`;
}

function confirmPage({ siteName, email, token, slug }) {
  const action = `/user/verify-email${slug ? `?tenant=${encodeURIComponent(slug)}` : ''}`;
  return pageShell(
    siteName,
    'Confirm your email address',
    `<p style="margin:0 0 20px;line-height:1.6;font-size:14px;color:#3f3f46">Press the button to confirm that <strong>${escapeHtml(email)}</strong> is your address.</p>
    <form method="post" action="${escapeHtml(action)}" style="margin:0">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button type="submit" style="background:#18181b;color:#ffffff;border:0;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer">Confirm my email</button>
    </form>
    <p style="margin:20px 0 0;line-height:1.6;font-size:12px;color:#a1a1aa">Not you? Close this page and nothing will change.</p>`
  );
}

function invalidPage({ siteName }) {
  return pageShell(siteName, 'This link no longer works', `<p style="margin:0;line-height:1.6;font-size:14px;color:#3f3f46">${escapeHtml(LINK_INVALID)}</p>`);
}

module.exports = {
  VERIFY_TOKEN_TTL_DAYS,
  LINK_INVALID,
  looksLikeEmail,
  emailIsVerified,
  unprovenIds,
  apiOrigin,
  sendLink,
  pending,
  confirm,
  markVerified,
  confirmationEmail,
  confirmPage,
  invalidPage
};
