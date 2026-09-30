// scripts/lib/emailIndex.js
//
// The work behind scripts/migrateEmailIndex.js, on one gym's `users`
// collection, kept apart from the script's gym selection so the integration
// tests can run it against a real database.
//
// Email used to be required and unique on every account: one index,
// `email_1`, unique over every document. Members may now have no email
// address, so it becomes unique only among the accounts that have one
// (partialFilterExpression { email: { $type: 'string' } }). With the old
// index in place, a second member without an email is refused -- both are
// "null" to it.
//
// The steps, in the only order that works:
//
//   1. drop the old `email_1` -- while it exists, unsetting a blank email
//      below would give two accounts a "null" it refuses;
//   2. unset any '' or null email -- the model never stores those now, and
//      the new index must not see them;
//   3. create the partial unique index under the same name.
//
// Between 1 and 3 nothing enforces uniqueness; it is a moment, and the old
// index guaranteed there were no duplicates to begin with. A gym whose index
// is already the new one is left alone, so running it twice is harmless.

const INDEX_NAME = 'email_1';
const PARTIAL = { email: { $type: 'string' } };
// A stored '' or an explicit null -- not a missing field, which is already
// what "no email" looks like.
const BLANK = { $or: [{ email: '' }, { email: { $type: 'null' } }] };

function isEmailOnly(index) {
  const keys = Object.keys(index.key || {});
  return keys.length === 1 && keys[0] === 'email';
}

function isTarget(index) {
  return (
    isEmailOnly(index) &&
    index.unique === true &&
    !!index.partialFilterExpression &&
    JSON.stringify(index.partialFilterExpression) === JSON.stringify(PARTIAL)
  );
}

/** What needs doing on this collection. Changes nothing. */
async function planEmailIndex(collection) {
  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch (error) {
    // A gym with no users collection yet: the app builds the right index
    // the first time it creates one.
    if (error && (error.codeName === 'NamespaceNotFound' || error.code === 26)) {
      return { exists: false, current: null, drop: [], blanks: 0, create: false, upToDate: true };
    }
    throw error;
  }

  const onEmail = indexes.filter(isEmailOnly);
  const target = onEmail.find(isTarget);
  // Every other index on email alone goes: the old always-unique one, or a
  // leftover of another shape under the name the new one needs.
  const drop = onEmail.filter((index) => index !== target).map((index) => index.name);
  const blanks = await collection.countDocuments(BLANK);

  return {
    exists: true,
    current: onEmail.map((index) => ({ name: index.name, unique: !!index.unique, partial: index.partialFilterExpression || null })),
    drop,
    blanks,
    create: !target,
    upToDate: !!target && !drop.length && !blanks
  };
}

/**
 * Brings the collection to the new index. With apply false it only reports
 * the plan (the default for the script).
 */
async function migrateEmailIndex(collection, { apply = false } = {}) {
  const plan = await planEmailIndex(collection);
  if (!apply || plan.upToDate || !plan.exists) return { ...plan, applied: false };

  for (const name of plan.drop) await collection.dropIndex(name);
  const unset = plan.blanks ? await collection.updateMany(BLANK, { $unset: { email: '' } }) : { modifiedCount: 0 };
  if (plan.create) {
    await collection.createIndex({ email: 1 }, { name: INDEX_NAME, unique: true, partialFilterExpression: PARTIAL });
  }
  return { ...plan, applied: true, unset: unset.modifiedCount || 0 };
}

module.exports = { planEmailIndex, migrateEmailIndex, INDEX_NAME, PARTIAL };
