// src/services/passwordCheck.js
//
// Checking a password at sign-in. bcrypt is slow on purpose -- tens of
// milliseconds at cost 10 -- so a sign-in that answered at once for a name
// nobody has, and ran bcrypt only for a real account, told anyone timing it
// which names exist. Generated usernames are a name plus three digits, so
// they are easy to walk through. With no account, or one with no password,
// the same work is done against a fixed hash of the same cost, and the
// answer is still no.

const bcrypt = require('bcryptjs');

// bcrypt at cost 10, the cost every account's hash is made with. What it is
// the hash of does not matter: a match against it is never a sign-in.
const NO_ACCOUNT_HASH = '$2b$10$FiA0kOcffOBGs.TQq0BxUegjkpWBikYpb7hjE.zk75PnDKd4Ym.ZW';

/**
 * Whether `password` matches `hash`, taking as long when there is no hash.
 * Called through the bcrypt module object, so tests can watch it.
 */
async function passwordMatches(password, hash) {
  const typed = String(password || '');
  if (typeof hash === 'string' && hash) return bcrypt.compare(typed, hash);
  await bcrypt.compare(typed, NO_ACCOUNT_HASH);
  return false;
}

/**
 * "Type your current password to do this": the check before a signed-in
 * account changes something that decides who can get back into it -- its
 * email address, its two-factor step. A session can be stolen (a shared
 * computer, a copied token) without the password being known, and without
 * this such a session could make the account its own for good.
 *
 * `toDo` finishes the sentence: "change your email address". Resolves to
 * null when the password is right, or to the body of the 400 to send:
 *
 *   PASSWORD_REQUIRED   none was sent
 *   PASSWORD_INCORRECT  it does not match
 *   PASSWORD_NOT_SET    the account has none (it only ever used Google) --
 *                       "Forgot password" emails its address a link to set
 *                       one, which is the proof this check stands for
 *
 * @param {{ password?: string|null }} account  loaded with its password hash
 */
async function currentPasswordRefusal(account, typed, { toDo = 'do this' } = {}) {
  if (!account || !account.password) {
    return {
      code: 'PASSWORD_NOT_SET',
      message: `This account signs in with Google and has no password yet. Set one with "Forgot password" on the sign-in page, then ${toDo}.`
    };
  }
  if (!typed || typeof typed !== 'string') {
    return {
      code: 'PASSWORD_REQUIRED',
      message: `Enter your current password to ${toDo}. It stops anyone else who gets into your account from taking it over.`
    };
  }
  if (!(await passwordMatches(typed, account.password))) {
    return { code: 'PASSWORD_INCORRECT', message: 'That password is not right, so nothing was changed.' };
  }
  return null;
}

module.exports = { passwordMatches, currentPasswordRefusal };
