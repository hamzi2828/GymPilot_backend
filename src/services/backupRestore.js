// src/services/backupRestore.js
//
// Putting a gym back as a backup had it (Settings → Data & backup → Restore).
//
// From a stored backup, or a file the owner uploaded (its own download, which
// the browser encrypts for this gym before it goes to the store -- see
// controller/backupController.js). Always in this order:
//
//   1. preview   read the whole file -- decrypted, every chunk authenticated,
//                every count checked against the manifest -- and say what is
//                in it: which gym, when, which collections, how many records.
//   2. confirm   the owner types the gym's slug.
//   3. refuse    a backup of another gym (its header names the gym by id;
//                an uploaded file is also encrypted with this gym's key).
//   4. back up   the gym as it is now, stored as a 'pre-restore' backup. If
//                that cannot be made, nothing is touched.
//   5. stage     every collection in the file is loaded into a staging
//                collection beside the live one (__restoring__<name>), with
//                its options and indexes. The live data is untouched until
//                the whole file has been read and checked; any failure drops
//                the staging collections and leaves the gym as it was.
//   6. swap      each staging collection replaces its live one (rename with
//                dropTarget), and live collections the backup does not have
//                are dropped -- the gym is then exactly what the file holds.
//   7. sign out  every session ends, everyone's (endEverySession): the
//                accounts came back with the sign-ins the backup knew of,
//                some of which were ended on purpose since.
//
// Never touched: MongoDB's and the platform's collections (see
// backupService.isGymCollection), and the admin audit log, which keeps its
// history through a restore -- a restore must not be a way to erase the
// record of what was done, the restore itself included.
//
// One restore per gym at a time (a lock row in platform_job_runs, job
// 'restore', released when done or after 15 minutes).

const { pipeline } = require('stream/promises');
const PlatformJobRun = require('../platform/models/platformJobRunModel');
const { currentTenant } = require('../platform/tenantContext');
const backups = require('./backupService');
const backupCrypto = require('./backupCrypto');
const backupJobs = require('./backupJobs');
const storage = require('./backupStorage');

const { STAGING_PREFIX } = backups;
// Kept as they are, whatever the backup holds.
const KEPT_ON_RESTORE = new Set(['gym_admin_audit_logs']);
const LOCK_MS = 15 * 60 * 1000;

// An error whose message is meant for the owner, whatever its status.
function refusal(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.expose = true;
  return error;
}

/** Whether a restore replaces this collection (and a backup's copy of it is loaded). */
function restorable(name) {
  return backups.isGymCollection({ name, type: 'collection' }) && !KEPT_ON_RESTORE.has(name);
}

/** The backup's plain archive (.tar.gz bytes), decrypted as it is read. */
async function openBackup(entry) {
  const gym = currentTenant();
  const source = await storage.open(entry.url);
  const decrypted = backupCrypto.decryptStream(String(gym._id));
  pipeline(source, decrypted).catch((error) => decrypted.destroy(error));
  return decrypted;
}

/** Why this archive may not be restored into the gym in context, or null. */
function headerRefusal(header, gym) {
  if (!header || header.kind !== 'gym' || !header.gym) {
    return refusal(409, 'BACKUP_NOT_A_GYM', 'This is not a gym backup (it may be the platform\'s own), so it cannot be restored here.');
  }
  if (String(header.gym.id) !== String(gym._id)) {
    const which = header.gym.name ? `${header.gym.name} (${header.gym.slug})` : header.gym.slug;
    return refusal(409, 'BACKUP_OTHER_GYM', `This backup is of another gym, ${which}. Only this gym's own backups can be restored here.`);
  }
  return null;
}

/**
 * Step 1: reads the whole backup and describes it. Throws for a file that
 * cannot be read; a readable backup of another gym is described, with
 * `refusal` saying why it cannot be restored.
 */
async function previewRestore(entry, { actorId = null } = {}) {
  const gym = currentTenant();
  let actorInBackup = false;
  const summary = await backups.summarizeArchive(await openBackup(entry), {
    onDocuments: (name, documents) => {
      if (name === 'users' && actorId && !actorInBackup) actorInBackup = documents.some((doc) => String(doc._id) === String(actorId));
    }
  });
  const problem = headerRefusal(summary.header, gym);
  return {
    backup: { id: String(entry._id), kind: entry.kind },
    gym: summary.header.gym,
    createdAt: summary.header.createdAt,
    trigger: summary.header.trigger,
    sameGym: !problem,
    refusal: problem ? problem.message : null,
    collections: summary.collections.map((c) => ({ name: c.name, documents: c.documents, indexes: c.indexes, kept: !restorable(c.name) })),
    documents: summary.documents,
    // The account doing the restore is not in the backup: it will not exist
    // afterwards, and this session will end.
    actorInBackup,
    confirmWith: gym.slug
  };
}

// Reads just the header, for the refusal to come before anything is done.
async function readHeader(entry) {
  const source = await openBackup(entry);
  const events = backups.readArchive(source);
  try {
    const first = await events.next();
    return first.done ? null : first.value.header;
  } finally {
    await events.return();
    source.destroy();
  }
}

// The gym's 'restore' row is free when no restore ever started, when the
// last one finished (lastRunAt caught up with lastStartedAt), or when one
// started so long ago that the function running it must have been stopped.
// Taking it is one conditional write, so two restores cannot both get it.
async function acquireLock(gym, now = new Date()) {
  await PlatformJobRun.updateOne(
    { job: 'restore', gymId: gym._id },
    { $setOnInsert: { gymSlug: gym.slug, lastStartedAt: null } },
    { upsert: true }
  ).catch((error) => {
    // Two first-ever restores racing to create the row: it exists now.
    if (!error || error.code !== 11000) throw error;
  });
  const taken = await PlatformJobRun.updateOne(
    {
      job: 'restore',
      gymId: gym._id,
      $or: [{ lastStartedAt: null }, { lastStartedAt: { $lt: new Date(now.getTime() - LOCK_MS) } }, { $expr: { $gte: ['$lastRunAt', '$lastStartedAt'] } }]
    },
    { $set: { gymSlug: gym.slug, lastStartedAt: now } }
  );
  if (!taken.matchedCount) throw refusal(409, 'RESTORE_IN_PROGRESS', 'A restore of this gym is already running. Wait for it to finish.');
}

function releaseLock(gym, outcome, began) {
  return PlatformJobRun.updateOne(
    { job: 'restore', gymId: gym._id },
    {
      $set: {
        lastRunAt: new Date(),
        lastOutcome: outcome.error ? 'error' : 'ok',
        lastError: outcome.error ? String(outcome.error.message || outcome.error).slice(0, 500) : '',
        lastDurationMs: Date.now() - began
      }
    }
  ).catch((error) => console.error(`[restore] could not release the lock for ${gym.slug}:`, error.message));
}

async function dropStaging(db) {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((name) => name.startsWith(STAGING_PREFIX));
  for (const name of names) await db.dropCollection(name).catch(() => {});
}

// A collection's options as createCollection takes them (a view is never in
// a backup; its fields are dropped all the same).
function collectionOptions(options = {}) {
  const { viewOn, pipeline: viewPipeline, ...rest } = options || {};
  return rest;
}

// An index as listIndexes described it, as createIndexes takes it.
function indexSpec(index) {
  const { ns, ...spec } = index;
  return spec;
}

/** Step 5: every restorable collection in the file, into staging. */
async function loadIntoStaging(db, source, gym) {
  const loaded = [];
  let current = null;
  try {
    for await (const event of backups.readArchive(source)) {
      if (event.type === 'header') {
        const problem = headerRefusal(event.header, gym);
        if (problem) throw problem;
      } else if (event.type === 'collection') {
        const { name, options, indexes } = event.collection;
        current = null;
        if (!restorable(name)) continue;
        const staging = `${STAGING_PREFIX}${name}`;
        await db.createCollection(staging, collectionOptions(options));
        current = { name, staging, indexes, documents: 0 };
        loaded.push(current);
      } else if (event.type === 'documents') {
        if (!current || current.name !== event.name || !event.documents.length) continue;
        // As stored: the documents passed their validators when they were
        // written, and must come back even if a validator changed since.
        await db.collection(current.staging).insertMany(event.documents, { ordered: true, bypassDocumentValidation: true });
        current.documents += event.documents.length;
      }
      // The manifest: readArchive has checked every count against it.
    }
    // Indexes last: building them once over the loaded data is quicker than
    // keeping them up to date through every insert.
    for (const c of loaded) {
      const specs = c.indexes.filter((index) => index.name !== '_id_').map(indexSpec);
      if (specs.length) await db.collection(c.staging).createIndexes(specs);
    }
    return loaded;
  } catch (error) {
    await dropStaging(db);
    throw error;
  }
}

/** Step 6: staging replaces live; what the backup does not have goes. */
async function swapIn(db, loaded) {
  const incoming = new Set(loaded.map((c) => c.name));
  const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  for (const c of loaded) await db.renameCollection(c.staging, c.name, { dropTarget: true });
  const dropped = [];
  for (const name of existing) {
    if (incoming.has(name) || !restorable(name)) continue;
    await db.dropCollection(name).catch((error) => {
      if (!error || error.code !== 26) throw error;
    });
    dropped.push(name);
  }
  return dropped;
}

// The highest tokenVersion any account in the live `users` holds.
async function highestTokenVersion(db) {
  const top = await db.collection('users').find({}, { projection: { tokenVersion: 1 } }).sort({ tokenVersion: -1 }).limit(1).next();
  return Number((top && top.tokenVersion) || 0);
}

// Step 7. A restore puts every account back as the backup had it,
// tokenVersion included, and the desk sign-ins (gym_desktop_tokens) with
// them. Left so, a session ended since the backup -- the password reset
// after a token was stolen, a deactivation, "sign out everywhere" -- would
// work again. So every session ends:
//
//   * every account's tokenVersion becomes one number above any a token
//     can carry. A token carries the version its account had when it was
//     issued, and there are tokens from every version between the backup
//     and now, so the restored value plus one would bring some back. The
//     number is above the highest version live before the swap
//     (`liveHighest`) and in the backup, and above the time in seconds --
//     far past any count of sign-outs -- which covers accounts deleted
//     since the backup, whose later versions are nowhere left to read;
//   * reset links and emailed sign-in codes pending in the backup go;
//   * every desk sign-in is revoked;
//   * this process forgets the gym's cached sessions (other instances
//     re-read theirs within 30 seconds, middleware/auth.js).
async function endEverySession(db, liveHighest) {
  const users = db.collection('users');
  const next = Math.max(liveHighest, await highestTokenVersion(db), Math.floor(Date.now() / 1000)) + 1;
  await users.updateMany({}, { $set: { tokenVersion: next } });
  await users.updateMany({ passwordResetTokenHash: { $ne: null } }, { $set: { passwordResetTokenHash: null, passwordResetExpiresAt: null } });
  await users.updateMany({ 'twoFactor.pending.challengeId': { $ne: null } }, { $set: { 'twoFactor.pending': null } });
  await db.collection('gym_desktop_tokens').updateMany({ revokedAt: null }, { $set: { revokedAt: new Date() } });
  require('../middleware/auth').forgetGymSessions();
}

// The phone app finds a member's gym by username in the platform-wide
// directory (platform_member_logins), which is not in a gym's backup and so
// was left as it was: members deleted since the backup came back unable to
// use the app, and accounts made since kept rows pointing at nobody. The
// gym's rows are rebuilt from the restored accounts instead. A username a
// member of another gym has taken since stays theirs -- usernames are
// unique across the platform -- and is reported, so staff can give the
// restored member a new one.
async function rebuildMemberLogins(db, gym) {
  const MemberDirectory = require('../platform/models/memberDirectoryModel');
  const accounts = await db.collection('users').find({ username: { $nin: [null, ''] } }, { projection: { username: 1 } }).toArray();
  await MemberDirectory.deleteMany({ gymId: gym._id });
  const at = new Date();
  const rows = accounts.map((user) => ({
    username: String(user.username).toLowerCase().trim(),
    gymId: gym._id,
    gymSlug: gym.slug,
    userId: user._id,
    createdAt: at,
    updatedAt: at
  }));
  const taken = [];
  if (rows.length) {
    try {
      // Straight through the driver: one round trip, and every row that can
      // go in does, whatever the others do.
      await MemberDirectory.collection.insertMany(rows, { ordered: false });
    } catch (error) {
      const failures = error.writeErrors ? [].concat(error.writeErrors) : [];
      if (!failures.length || failures.some((failure) => failure.code !== 11000)) throw error;
      for (const failure of failures) taken.push(rows[failure.index].username);
    }
  }
  return { published: rows.length - taken.length, taken };
}

// What this process remembers about the gym, read from the collections just
// replaced. Other instances catch up as their caches expire (a minute at most).
function forgetCachedState() {
  const quietly = (fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[restore] could not reset a cache:', error.message);
    }
  };
  quietly(() => require('./roleService').invalidate());
  quietly(() => require('../gymfolio/services/bookingRules').resetRulesCache());
  quietly(() => require('./gymNotifications').resetBrandCache());
  quietly(() => require('../models/homeSectionModel').resetDefaultsCache());
}

/**
 * Steps 2-6 for the gym in context. `entry` is the platform_backups row of
 * the file. Resolves with what was done; throws (with `status` and `code`)
 * when it was refused or failed -- having left the gym as it was, unless the
 * swap itself failed part-way, which the message says, naming the backup
 * taken just before.
 */
async function restoreBackup(entry, { confirm, actor = null, now = new Date() } = {}) {
  const gym = currentTenant();
  if (String(confirm || '').trim().toLowerCase() !== gym.slug) {
    throw refusal(400, 'CONFIRMATION_MISMATCH', `Type "${gym.slug}" to confirm the restore.`);
  }
  const state = backupJobs.readiness();
  if (!state.ready) throw refusal(409, 'BACKUPS_NOT_CONFIGURED', state.reason);

  const began = Date.now();
  await acquireLock(gym, now);
  const outcome = {};
  try {
    const problem = headerRefusal(await readHeader(entry), gym);
    if (problem) throw problem;

    const db = backups.tenantDb();
    // Left over from a restore that was cut off (the function's time limit).
    await dropStaging(db);

    let safety;
    try {
      // The tidy-up after it must spare the file being restored, which is
      // only opened below: an upload over a day old, or the oldest of a kind
      // at its keep limit, would otherwise be deleted before it was read.
      safety = await backupJobs.storeBackup({ kind: 'pre-restore', actor, now, spare: [entry._id] });
    } catch (error) {
      console.error(`[restore] ${gym.slug}: the backup before restoring failed:`, error);
      throw refusal(503, 'PRE_RESTORE_BACKUP_FAILED', 'Nothing was restored: the backup of the gym as it is now could not be made first. Please try again.');
    }

    const loaded = await loadIntoStaging(db, await openBackup(entry), gym);
    const liveHighest = await highestTokenVersion(db);
    let dropped;
    try {
      dropped = await swapIn(db, loaded);
    } catch (error) {
      console.error(`[restore] ${gym.slug}: the swap failed part-way:`, error);
      await dropStaging(db).catch(() => {});
      // Whichever accounts are live now, nobody keeps a session from either side.
      await endEverySession(db, liveHighest).catch((e) => console.error(`[restore] ${gym.slug}: could not end the sessions:`, e));
      throw refusal(
        500,
        'RESTORE_INCOMPLETE',
        'The restore failed part-way through, so the gym may now be a mix of both. Restore the backup listed as "Before a restore" to put it back as it was.'
      );
    }
    forgetCachedState();
    try {
      await endEverySession(db, liveHighest);
    } catch (error) {
      console.error(`[restore] ${gym.slug}: could not end the sessions:`, error);
      throw refusal(500, 'RESTORE_SIGN_OUT_FAILED', 'The backup was restored, but not every session could be ended. Run the restore again to end them.');
    }
    let memberLogins;
    try {
      memberLogins = await rebuildMemberLogins(db, gym);
    } catch (error) {
      // The gym itself is restored; only the app's lookup is behind.
      console.error(`[restore] ${gym.slug}: could not rebuild the phone app's usernames:`, error);
      memberLogins = { error: "The phone app's usernames could not be rebuilt: run scripts/assignUsernames.js --repair for this gym." };
    }

    // An uploaded file has done its job.
    if (entry.kind === 'upload') {
      await backupJobs.removeBackup(entry).catch((error) => console.error(`[restore] could not remove the uploaded file of ${gym.slug}:`, error.message));
    }

    return {
      collections: loaded.map((c) => ({ name: c.name, documents: c.documents })),
      documents: loaded.reduce((n, c) => n + c.documents, 0),
      dropped,
      kept: [...KEPT_ON_RESTORE],
      safetyBackup: String(safety._id),
      // The phone app's usernames: how many were published, and any taken
      // by another gym's member since the backup.
      memberLogins,
      // Everyone, the admin who ran it included, signs in again (step 7).
      signedOut: true
    };
  } catch (error) {
    outcome.error = error;
    throw error;
  } finally {
    await releaseLock(gym, outcome, began);
  }
}

module.exports = {
  STAGING_PREFIX,
  KEPT_ON_RESTORE,
  restorable,
  previewRestore,
  restoreBackup
};
