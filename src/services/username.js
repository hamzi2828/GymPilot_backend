// src/services/username.js
//
// Every member gets a username the gym can read out over the desk: their
// name, or their email address when the name is not usable, plus three
// digits. "Sara Malik / sara.malik@example.com" becomes `saramalik284`.
//
// Usernames are unique across the WHOLE platform, not just one gym, because
// the mobile app signs a member in with nothing but their username and
// password -- the username is what tells us which gym they belong to (see
// platform/models/memberDirectoryModel.js).

const User = require('../models/user');
const MemberDirectory = require('../platform/models/memberDirectoryModel');

const MAX_BASE = 14;
const DIGITS = 3;
const ATTEMPTS = 40;

/** Letters and digits only, lowercased: what a person can say out loud. */
function clean(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The readable part, before the digits. The name first; the email's local
 * part when there is no usable name.
 */
function baseFor({ firstName, lastName, email } = {}) {
  const fromName = clean(`${firstName || ''}${lastName || ''}`);
  const fromEmail = clean(String(email || '').split('@')[0]);
  const base = fromName.length >= 3 ? fromName : fromEmail || fromName;
  // "member" is only ever reached by an account with neither a name nor an
  // email, which the user model does not allow -- it exists so this function
  // can never return just a number.
  return (base || 'member').slice(0, MAX_BASE);
}

function digits(count) {
  const min = 10 ** (count - 1);
  return String(min + Math.floor(Math.random() * (10 ** count - min)));
}

/** Free both inside this gym and across the platform. */
async function isFree(username, { userId } = {}) {
  const taken = await User.findOne({ username, ...(userId ? { _id: { $ne: userId } } : {}) })
    .select('_id')
    .lean();
  if (taken) return false;
  return !(await MemberDirectory.isTaken(username, userId));
}

/**
 * A username nobody else has. Tries three digits first and widens to four
 * only if a gym somehow has forty members with the same name.
 */
async function generateUsername(user = {}) {
  const base = baseFor(user);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const width = attempt < ATTEMPTS - 5 ? DIGITS : DIGITS + 1;
    const candidate = `${base}${digits(width)}`;
    if (await isFree(candidate, { userId: user._id })) return candidate;
  }
  // Unreachable in practice; better than returning a duplicate.
  return `${base}${Date.now().toString().slice(-6)}`;
}

/**
 * Give a saved user a username and publish it to the platform directory, so
 * the mobile app can find their gym from it. Safe to call twice: a user who
 * already has one keeps it, and only the directory entry is refreshed.
 */
async function assignUsername(user, { force = false } = {}) {
  if (!user) return null;
  if (!user.username || force) {
    user.username = await generateUsername(user);
    await user.save();
  }
  await MemberDirectory.publish(user);
  return user.username;
}

// ---------------------------------------------------------------------------
// Signing in with a username
//
// The website and the front-desk app take "email or username" in one box.
// An address has an @ and a username never does (clean() above keeps letters
// and digits only), so the box's content says which it is. Both are stored
// lowercased, so the match is case-insensitive.
// ---------------------------------------------------------------------------

/** The account filter for what was typed into a sign-in box, or null. */
function loginFilter(identifier) {
  const value = String(identifier || '').toLowerCase().trim();
  if (!value) return null;
  return value.includes('@') ? { email: value } : { username: value };
}

// ---------------------------------------------------------------------------
// A username chosen by staff
//
// Generated ones are the name plus digits; a gym may prefer something else
// ("ali.khan" is not allowed, "alikhan" is). The rules are the generator's:
// letters and digits only, so it can be read out and typed on a phone, and
// at least one letter, so it is never mistaken for a phone or member number.
// ---------------------------------------------------------------------------

const MIN_CHOSEN = 3;
const MAX_CHOSEN = 30;

/** Why `value` cannot be a username, or null. Case is ignored. */
function usernameProblem(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'A username is required';
  if (!/^[a-z0-9]+$/.test(text)) return 'A username is letters and digits only: no spaces, dots or symbols';
  if (text.length < MIN_CHOSEN) return `A username needs at least ${MIN_CHOSEN} characters`;
  if (text.length > MAX_CHOSEN) return `A username can be at most ${MAX_CHOSEN} characters`;
  if (!/[a-z]/.test(text)) return 'A username needs at least one letter';
  return null;
}

/**
 * The `PUT .../:id/username { username }` handler for one screen. `load(id)`
 * finds the account the screen may touch. The old username stops working at
 * once -- on the website, the desk and the phone app (the model's save hook
 * moves the platform directory row) -- so the person has to be told.
 */
function setUsernameHandler({ load, notFound = 'User not found' }) {
  return async (req, res) => {
    try {
      const mongoose = require('mongoose');
      if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) {
        return res.status(404).json({ success: false, message: notFound });
      }
      const user = await load(req.params.id);
      if (!user) return res.status(404).json({ success: false, message: notFound });

      // Held to the set-password line: an administrator's sign-in name is an
      // administrator's business, and nobody renames an account that reaches
      // further than their own (services/adminPasswords.js).
      const { usernameRefusal } = require('./adminPasswords');
      const refusal = await usernameRefusal(req, user);
      if (refusal) return res.status(403).json({ success: false, message: refusal });

      const wanted = req.body && req.body.username;
      const problem = usernameProblem(wanted);
      if (problem) return res.status(400).json({ success: false, message: problem });
      const username = String(wanted).trim().toLowerCase();

      if (username !== user.username) {
        if (!(await isFree(username, { userId: user._id }))) {
          return res.status(409).json({ success: false, message: 'That username is already taken. Try adding a few digits.' });
        }
        user.username = username;
        await user.save();
      }

      return res.json({ success: true, message: `Username set to ${username}.`, data: { id: String(user._id), username } });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ success: false, message: 'That username is already taken. Try adding a few digits.' });
      }
      console.error('[username] set failed:', error);
      return res.status(500).json({ success: false, message: 'Could not change the username' });
    }
  };
}

module.exports = { generateUsername, assignUsername, baseFor, clean, isFree, loginFilter, usernameProblem, setUsernameHandler };
