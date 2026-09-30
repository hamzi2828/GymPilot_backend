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

module.exports = { passwordMatches };
