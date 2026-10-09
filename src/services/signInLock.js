// src/services/signInLock.js
//
// A ceiling on password guesses per account, kept on the account itself.
//
// The limits in middleware/rateLimit.js live in memory: they reset whenever
// a serverless instance starts cold, each instance counts on its own, and
// they are per address -- a guesser who spreads over many addresses never
// meets them. This one is in the database, so it holds across instances and
// addresses alike: an account gets MAX_ATTEMPTS password tries, and after
// that many wrong in a row its password is not checked again for
// LOCK_MINUTES.
//
// It must not become a way to shut somebody out of their own account, so:
//
//   * it is time-based and clears itself -- there is no state a crash can
//     leave it in that lasts longer than LOCK_MINUTES;
//   * a right password clears the count;
//   * a new password (a reset link, "change password", staff setting one at
//     the desk) opens it at once: the wrong tries were about the old one.
//     Read off passwordChangedAt, which every one of those already writes;
//   * it only pauses the PASSWORD. A Google sign-in, an emailed reset and
//     the sessions already open are untouched.
//
// Every try is counted BEFORE the password is compared, in one conditional
// write, so a burst of parallel guesses cannot all be checked against the
// count as it stood when they started.
//
// How it is stored: `signInAttempts` tries used in the window that ends at
// `signInWindowEndsAt`. A window starts with the first try after none is
// running and lasts LOCK_MINUTES; when its last try is wrong it is pushed
// out to LOCK_MINUTES from that moment, which is the pause.

const User = require('../models/user');
const { passwordMatches } = require('./passwordCheck');

const MAX_ATTEMPTS = 10;
const LOCK_MINUTES = 15;
const LOCK_MS = LOCK_MINUTES * 60 * 1000;

// Said with every refused sign-in -- wrong password, unknown name and paused
// account alike -- so the answer never tells which of the three it was, and
// somebody who is paused still learns why their right password is not
// working.
const PAUSE_NOTE = `After ${MAX_ATTEMPTS} wrong tries, sign-in for an account pauses for ${LOCK_MINUTES} minutes.`;

// An id no account has: what a sign-in for a name nobody has writes to, so
// it makes the same round trip a real account's does.
const NO_ACCOUNT_ID = '000000000000000000000000';

/**
 * Takes one of the account's tries. Resolves to how many it has now used in
 * the running window (1..MAX_ATTEMPTS), or 0 when it has none left: sign-in
 * for it is paused, and the password must not be checked.
 */
async function claimAttempt(userId, now = new Date()) {
  // Twice round: two first tries arriving together both find no window, one
  // starts it, and the other must then find it rather than be turned away.
  for (let turn = 0; turn < 2; turn++) {
    // A try inside the running window, while it has any left.
    const inWindow = await User.findOneAndUpdate(
      { _id: userId, signInWindowEndsAt: { $gt: now }, signInAttempts: { $lt: MAX_ATTEMPTS } },
      { $inc: { signInAttempts: 1 } },
      { new: true }
    )
      .select('signInAttempts')
      .lean();
    if (inWindow) return inWindow.signInAttempts;

    // No window running -- never one, it ran out, or the password has been
    // changed since it began (see the top of this file): this try starts one.
    const started = await User.findOneAndUpdate(
      {
        _id: userId,
        $or: [
          { signInWindowEndsAt: null },
          { signInWindowEndsAt: { $lte: now } },
          { $expr: { $gte: ['$passwordChangedAt', { $subtract: ['$signInWindowEndsAt', LOCK_MS] }] } }
        ]
      },
      { $set: { signInAttempts: 1, signInWindowEndsAt: new Date(now.getTime() + LOCK_MS) } },
      { new: true }
    )
      .select('signInAttempts')
      .lean();
    if (started) return started.signInAttempts;
  }
  return 0;
}

/** The last try of a window was wrong: the pause runs LOCK_MINUTES from now. */
async function pause(userId, now = new Date()) {
  await User.updateOne(
    { _id: userId, signInAttempts: { $gte: MAX_ATTEMPTS } },
    { $set: { signInWindowEndsAt: new Date(now.getTime() + LOCK_MS) } }
  );
}

/** A right password, or a new one: the count starts again. */
async function clear(userId) {
  await User.updateOne({ _id: userId }, { $set: { signInAttempts: 0, signInWindowEndsAt: null } });
}

/**
 * Whether `password` is `account`'s, under the ceiling above: every call
 * uses one of the account's tries, and a paused account is answered "no"
 * whatever was typed. `account` is null for a name nobody has. The bcrypt
 * work is done in every case (services/passwordCheck.js), so neither the
 * answer nor the time it takes says whether the account exists, has a
 * password, or is paused.
 */
async function signInPasswordMatches(account, password) {
  const id = account && (account._id || account.id);
  if (!id) {
    try {
      if (!account) await User.updateOne({ _id: NO_ACCOUNT_ID, signInWindowEndsAt: { $gt: new Date() } }, { $inc: { signInAttempts: 1 } });
    } catch {
      // No gym in context to ask: there is nothing to keep in step with.
    }
    return passwordMatches(password, account && account.password);
  }

  const attempt = await claimAttempt(id);
  const matches = await passwordMatches(password, account.password);
  if (!attempt) return false;
  if (!matches) {
    if (attempt >= MAX_ATTEMPTS) await pause(id);
    return false;
  }
  await clear(id);
  return true;
}

module.exports = {
  MAX_ATTEMPTS,
  LOCK_MINUTES,
  PAUSE_NOTE,
  claimAttempt,
  clear,
  signInPasswordMatches
};
