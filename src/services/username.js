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

module.exports = { generateUsername, assignUsername, baseFor, clean, isFree };
