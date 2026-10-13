// src/services/backupService.js
//
// A whole gym as one file: every collection in the gym's database, each
// document in MongoDB Extended JSON, with each collection's options and index
// definitions beside it. The same archive is what the owner downloads from
// Settings → Data & backup, what the daily backup stores, and what
// scripts/backupGym.js writes to disk.
//
// The file is a gzipped tar -- any archive tool opens it -- laid out as
//
//   backup.json                    what this is: format, version, the gym
//                                  (id, slug, name), when, and why
//   collections/<name>.json        one collection's name, options, indexes
//   collections/<name>.jsonl       its documents, one canonical EJSON per
//   collections/<name>.2.jsonl     line, in parts of about 8 MB, so neither
//                                  end ever holds a whole collection in
//                                  memory. Each part is a file mongoimport
//                                  takes as it is.
//   …
//   manifest.json                  last: the header again plus how many
//                                  documents each collection had. A file
//                                  without it did not finish.
//
// The order is the point: whoever reads the archive meets the header first
// (and can refuse a stranger's backup before reading any data), each
// collection's definition before its documents, and the counts at the end,
// when they are known.
//
// What goes in: every collection of the gym's database except MongoDB's own
// (system.*) and the platform's (gyms, super_admins, platform_*) -- the gym
// the platform started with shares the platform's database, and its backup
// must carry neither the other gyms' records nor the super admins -- and a
// restore's leftover staging collections. Views are skipped (their
// definition, not data; none exist today).
//
// Secrets stay sealed. Documents are copied exactly as stored, so the
// Settings secrets (Stripe, SMTP, messaging) and fingerprint templates are in
// the archive as the ciphertext the database holds, opened only by this
// deployment's keys for this gym. A Settings secret saved before sealing
// existed, still plaintext in the database, is sealed on its way into the
// archive. A download that leaks leaks no working key.
//
// Not a point-in-time snapshot: collections are read one after another while
// the gym keeps running, as mongodump does without --oplog.

const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { EJSON } = require('mongoose').mongo.BSON;
const { currentConnection, currentTenant } = require('../platform/tenantContext');
const { seal, isSealed } = require('./secretBox');

const FORMAT = 'gympilot-backup';
const VERSION = 1;

// A collection's documents go out in parts of about this many bytes.
const PART_BYTES = 8 * 1024 * 1024;

// The platform's own collections, which live in the main database beside the
// first gym's data (platform/platformDb.js). No gym model uses these names,
// so they are left out of every gym's backup wherever the gym lives.
const PLATFORM_COLLECTIONS = new Set(['gyms', 'super_admins']);
const PLATFORM_PREFIX = 'platform_';

// Read after every other collection. The gym keeps running while a backup
// reads its collections one by one; read first (as by name, before sales,
// orders and payslips), the counters could miss a receipt or invoice number
// handed out meanwhile, and after a restore the next one would repeat it.
// Read last, they can only be ahead of what they numbered: a gap, never a
// repeat.
const READ_LAST = new Set(['gym_counters']);

function isPlatformCollection(name) {
  return PLATFORM_COLLECTIONS.has(name) || String(name).startsWith(PLATFORM_PREFIX);
}

/** Whether a listCollections entry belongs in a gym's backup. */
// A restore loads into collections with this prefix before swapping them in
// (services/backupRestore.js); one cut off part-way may leave some behind,
// and they are nobody's data.
const STAGING_PREFIX = '__restoring__';

function isGymCollection(info) {
  const name = String((info && info.name) || '');
  if (!name || name.startsWith('system.') || name.startsWith(STAGING_PREFIX)) return false;
  if (info.type && info.type !== 'collection') return false;
  return !isPlatformCollection(name);
}

/** The raw driver database of the gym in context. */
function tenantDb() {
  const connection = currentConnection();
  if (!connection) throw new Error('[backup] No gym in context');
  return connection.db || connection.getClient().db(connection.name);
}

/* ---------------------------------- tar ---------------------------------- */

// ustar: a 512-byte header per file, the file padded to 512, two empty
// blocks at the end. Written by hand -- a few lines, and no dependency.
const BLOCK = 512;

function octal(value, width) {
  return `${Math.floor(value).toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader(name, size, mtime) {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(mtime / 1000, 12), 136, 12, 'ascii');
  header.fill(' ', 148, 156); // the checksum counts its own field as spaces
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function* tarEntry(name, data, mtime) {
  yield tarHeader(name, data.length, mtime);
  if (data.length) yield data;
  const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
  if (pad) yield Buffer.alloc(pad, 0);
}

// backup.json and manifest.json are plain JSON anyone can read; a
// collection's definition is canonical, so its values keep their BSON types.
function jsonBytes(value, relaxed = true) {
  return Buffer.from(`${EJSON.stringify(value, null, 2, { relaxed })}\n`, 'utf8');
}

// File names are for people opening the archive; the reader goes by the name
// inside each collections/<name>.json. A name tar cannot hold in 100 bytes
// (with room for the part number) is numbered instead.
function fileBase(name, index) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,69}$/.test(name) ? name : `collection-${index + 1}`;
}

function partName(base, part) {
  return part === 1 ? `collections/${base}.jsonl` : `collections/${base}.${part}.jsonl`;
}

/* --------------------------------- writing --------------------------------- */

// Settings secrets written before sealing existed are still plaintext in the
// database; the backup must not be where they leak.
function sealSettingsSecrets(doc, paths) {
  for (const path of paths) {
    const keys = path.split('.');
    let holder = doc;
    for (const key of keys.slice(0, -1)) holder = holder && typeof holder === 'object' ? holder[key] : null;
    const last = keys[keys.length - 1];
    if (holder && typeof holder[last] === 'string' && holder[last] && !isSealed(holder[last])) {
      holder[last] = seal(holder[last]);
    }
  }
  return doc;
}

function settingsSecretPaths() {
  // Through the model so the list stays the model's own (models/settings.js).
  const Settings = require('../models/settings');
  return Settings.schema.statics.SECRET_PATHS || [];
}

/**
 * The archive's bytes, uncompressed. `result.manifest` is filled in once the
 * last entry has been produced.
 */
async function* archiveEntries({ db, gym, trigger, now = new Date(), select = isGymCollection, partBytes = PART_BYTES }, result) {
  const mtime = now.getTime();
  const header = {
    format: FORMAT,
    version: VERSION,
    kind: gym ? 'gym' : 'platform',
    gym: gym ? { id: String(gym._id), slug: gym.slug, name: gym.name } : null,
    createdAt: now.toISOString(),
    trigger: trigger || 'manual'
  };
  yield* tarEntry('backup.json', jsonBytes(header), mtime);

  // By name, but the counters last (READ_LAST).
  const order = (info) => `${READ_LAST.has(info.name) ? 1 : 0}${info.name}`;
  const infos = (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter(select)
    .sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));

  const collections = [];
  let total = 0;
  for (const [index, info] of infos.entries()) {
    const collection = db.collection(info.name);
    const base = fileBase(info.name, index);
    // A collection dropped since it was listed has no indexes to read (and no
    // documents): it goes in empty rather than failing the whole backup.
    const indexes = await collection
      .listIndexes()
      .toArray()
      .catch((error) => {
        if (error && error.code === 26) return [];
        throw error;
      });
    yield* tarEntry(`collections/${base}.json`, jsonBytes({ name: info.name, options: info.options || {}, indexes }, false), mtime);

    const secretPaths = gym && info.name === 'settings' ? settingsSecretPaths() : null;
    let part = 0;
    let count = 0;
    let lines = [];
    let bytes = 0;
    for await (const doc of collection.find({}, { batchSize: 500 })) {
      if (secretPaths) sealSettingsSecrets(doc, secretPaths);
      const line = Buffer.from(`${EJSON.stringify(doc, { relaxed: false })}\n`, 'utf8');
      lines.push(line);
      bytes += line.length;
      count += 1;
      if (bytes >= partBytes) {
        part += 1;
        yield* tarEntry(partName(base, part), Buffer.concat(lines, bytes), mtime);
        lines = [];
        bytes = 0;
      }
    }
    // An empty collection still gets its (empty) file, so every collection
    // restores -- with its indexes -- even when it holds nothing.
    if (bytes > 0 || part === 0) {
      part += 1;
      yield* tarEntry(partName(base, part), Buffer.concat(lines, bytes), mtime);
    }
    collections.push({ name: info.name, documents: count, indexes: indexes.length, parts: part });
    total += count;
  }

  const manifest = { ...header, finishedAt: new Date().toISOString(), collections, documents: total };
  yield* tarEntry('manifest.json', jsonBytes(manifest), mtime);
  yield Buffer.alloc(BLOCK * 2, 0);
  result.manifest = manifest;
}

/**
 * Writes a gym's archive, gzipped, through `streams` (the last one is where
 * it lands: a response, a file, an upload). Resolves with the manifest once
 * everything has been written; rejects -- having destroyed every stream --
 * when anything along the way fails.
 *
 * `gym` null with a `select` of the platform collections is the platform's
 * own backup (scripts/backupGym.js --all).
 */
async function writeArchive(options, ...streams) {
  const result = { manifest: null };
  await pipeline(Readable.from(archiveEntries(options, result), { objectMode: false }), zlib.createGzip(), ...streams);
  return result.manifest;
}

/* --------------------------------- reading --------------------------------- */

/** A file that is not a GymsPilotPro backup, or not a whole one. `message` is fit to show. */
class BackupFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupFileError';
    this.code = 'BACKUP_UNREADABLE';
    this.status = 400;
  }
}

// No entry in an archive of ours comes near this (parts are ~8 MB); anything
// bigger is not ours, and is refused before it is held in memory.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

function parseOctal(field) {
  const text = field.toString('ascii').replace(/\0.*$/s, '').trim();
  return text ? parseInt(text, 8) : 0;
}

function readTarHeader(block) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : block[i];
  if (parseOctal(block.subarray(148, 156)) !== sum) throw new BackupFileError('This file is not a GymsPilotPro backup (or it is damaged).');
  const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
  const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
  // A NUL type is an old-style regular file, as '0' is.
  return { name: prefix ? `${prefix}/${name}` : name, size: parseOctal(block.subarray(124, 136)), type: block[156] ? String.fromCharCode(block[156]) : '0' };
}

/**
 * The files in a tar stream, each as { name, data }. Holds one file at a
 * time. Throws BackupFileError for a file too big or a stream cut short.
 */
async function* tarFiles(source, maxEntryBytes = MAX_ENTRY_BYTES) {
  let carry = null; // fewer than 512 bytes left over from the last chunk
  let entry = null; // { name, type, remaining, pad, parts }
  let finished = false;

  const complete = () => entry && entry.remaining === 0 && entry.pad === 0;

  for await (const incoming of source) {
    let chunk = carry ? Buffer.concat([carry, incoming]) : incoming;
    carry = null;
    let offset = 0;
    while (offset < chunk.length && !finished) {
      if (entry) {
        const take = Math.min(entry.remaining, chunk.length - offset);
        if (take) entry.parts.push(chunk.subarray(offset, offset + take));
        offset += take;
        entry.remaining -= take;
        const skip = entry.remaining === 0 ? Math.min(entry.pad, chunk.length - offset) : 0;
        offset += skip;
        entry.pad -= skip;
        if (!complete()) break;
        const done = entry;
        entry = null;
        if (done.type === '0') yield { name: done.name, data: Buffer.concat(done.parts) };
        continue;
      }
      if (chunk.length - offset < BLOCK) {
        carry = Buffer.from(chunk.subarray(offset));
        break;
      }
      const block = chunk.subarray(offset, offset + BLOCK);
      offset += BLOCK;
      if (block.every((byte) => byte === 0)) {
        finished = true;
        break;
      }
      const header = readTarHeader(block);
      if (header.size > maxEntryBytes) throw new BackupFileError('This file is not a GymsPilotPro backup: it holds a part far larger than any backup writes.');
      entry = { name: header.name, type: header.type, remaining: header.size, pad: (BLOCK - (header.size % BLOCK)) % BLOCK, parts: [] };
      if (complete()) {
        const done = entry;
        entry = null;
        if (done.type === '0') yield { name: done.name, data: Buffer.alloc(0) };
      }
    }
    if (finished) return;
  }
  if (entry && complete() && entry.type === '0') {
    yield { name: entry.name, data: Buffer.concat(entry.parts) };
    entry = null;
  }
  if (entry) throw new BackupFileError('This backup is incomplete: the file ends part-way through.');
}

// The header and manifest are ours and read as plain values; a collection's
// options and indexes keep their exact BSON types for recreating it.
function parseJson(data, what, relaxed = true) {
  try {
    return EJSON.parse(data.toString('utf8'), { relaxed });
  } catch {
    throw new BackupFileError(`This backup is damaged: ${what} cannot be read.`);
  }
}

/**
 * Reads an archive (gzipped bytes, as writeArchive made them) and yields,
 * in order:
 *
 *   { type: 'header', header }                     backup.json
 *   { type: 'collection', collection }             { name, options, indexes }
 *   { type: 'documents', name, documents }         a part's documents, parsed
 *                                                  to their BSON types
 *   { type: 'manifest', manifest }                 last
 *
 * Checks as it goes that the file is one of ours, whole, and that each
 * collection holds as many documents as the manifest says -- a caller that
 * got through the manifest has read everything that was written. Anything
 * else throws BackupFileError.
 */
async function* readArchive(source, { maxEntryBytes = MAX_ENTRY_BYTES } = {}) {
  const gunzip = zlib.createGunzip();
  // The gunzip's errors (not gzip at all, cut short) surface through the
  // iterator below; this keeps the source's own errors from going unheard.
  const feeding = pipeline(source, gunzip).catch((error) => gunzip.destroy(error));

  let header = null;
  let manifest = null;
  let current = null;
  const counts = new Map();
  try {
    for await (const file of tarFiles(gunzip, maxEntryBytes)) {
      if (manifest) throw new BackupFileError('This backup is damaged: something follows its manifest.');
      if (!header) {
        if (file.name !== 'backup.json') throw new BackupFileError('This file is not a GymsPilotPro backup.');
        header = parseJson(file.data, 'its header');
        if (!header || header.format !== FORMAT) throw new BackupFileError('This file is not a GymsPilotPro backup.');
        if (!(Number(header.version) >= 1 && Number(header.version) <= VERSION)) {
          throw new BackupFileError('This backup was made by a newer version of GymsPilotPro and cannot be read here.');
        }
        yield { type: 'header', header };
        continue;
      }
      if (file.name === 'manifest.json') {
        manifest = parseJson(file.data, 'its manifest');
        for (const c of (manifest && manifest.collections) || []) {
          if (!counts.has(c.name) || counts.get(c.name) !== Number(c.documents)) {
            throw new BackupFileError(`This backup is incomplete: ${c.name} does not hold the ${c.documents} document(s) its manifest lists.`);
          }
        }
        if (((manifest && manifest.collections) || []).length !== counts.size) {
          throw new BackupFileError('This backup is damaged: its manifest does not match its contents.');
        }
        yield { type: 'manifest', manifest };
        continue;
      }
      if (/^collections\/[^/]+\.json$/.test(file.name)) {
        const collection = parseJson(file.data, file.name, false);
        if (!collection || typeof collection.name !== 'string' || !collection.name || counts.has(collection.name)) {
          throw new BackupFileError(`This backup is damaged: ${file.name} does not describe a collection.`);
        }
        current = { name: collection.name, options: collection.options || {}, indexes: Array.isArray(collection.indexes) ? collection.indexes : [] };
        counts.set(current.name, 0);
        yield { type: 'collection', collection: current };
        continue;
      }
      if (/^collections\/[^/]+\.jsonl$/.test(file.name)) {
        if (!current) throw new BackupFileError('This backup is damaged: documents come before their collection.');
        const documents = [];
        const text = file.data.toString('utf8');
        let start = 0;
        while (start < text.length) {
          let end = text.indexOf('\n', start);
          if (end === -1) end = text.length;
          const line = text.slice(start, end).trim();
          start = end + 1;
          if (!line) continue;
          try {
            documents.push(EJSON.parse(line, { relaxed: false }));
          } catch {
            throw new BackupFileError(`This backup is damaged: a document in ${file.name} cannot be read.`);
          }
        }
        counts.set(current.name, counts.get(current.name) + documents.length);
        yield { type: 'documents', name: current.name, documents };
        continue;
      }
      // Anything else (a note someone added?) is not ours to interpret.
    }
    if (!header) throw new BackupFileError('This file is not a GymsPilotPro backup.');
    if (!manifest) throw new BackupFileError('This backup is incomplete: it has no manifest, so it did not finish being written.');
  } catch (error) {
    if (error instanceof BackupFileError) throw error;
    // zlib's own complaints ("incorrect header check", "unexpected end of
    // file") mean the same to the owner.
    if (error && (error.code === 'Z_DATA_ERROR' || error.code === 'Z_BUF_ERROR' || error.errno === -3 || error.errno === -5)) {
      throw new BackupFileError('This file is not a GymsPilotPro backup (or it is damaged or cut short).');
    }
    throw error;
  } finally {
    gunzip.destroy();
    await feeding;
  }
}

/**
 * Reads a whole archive for its summary: header, manifest and per-collection
 * counts, without keeping any documents. `onDocuments(name, documents)` sees
 * each part as it goes by, for a caller that wants to look (e.g. whether an
 * account is in it).
 */
async function summarizeArchive(source, { onDocuments } = {}) {
  let header = null;
  let manifest = null;
  const collections = [];
  for await (const event of readArchive(source)) {
    if (event.type === 'header') header = event.header;
    else if (event.type === 'collection') collections.push({ name: event.collection.name, indexes: event.collection.indexes.length, documents: 0 });
    else if (event.type === 'documents') {
      collections[collections.length - 1].documents += event.documents.length;
      if (onDocuments) await onDocuments(event.name, event.documents);
    } else if (event.type === 'manifest') manifest = event.manifest;
  }
  return { header, manifest, collections, documents: collections.reduce((n, c) => n + c.documents, 0) };
}

/** The gym in context, as writeArchive wants it. */
function writeGymArchive({ trigger, now } = {}, ...streams) {
  return writeArchive({ db: tenantDb(), gym: currentTenant(), trigger, now }, ...streams);
}

/** A file name for a gym's archive taken at `when`. */
function archiveFileName(slug, when = new Date(), extension = 'tar.gz') {
  const stamp = when.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  return `${slug || 'gym'}-backup-${stamp}.${extension}`;
}

module.exports = {
  FORMAT,
  VERSION,
  PART_BYTES,
  STAGING_PREFIX,
  isGymCollection,
  isPlatformCollection,
  tenantDb,
  tarHeader,
  writeArchive,
  writeGymArchive,
  archiveFileName,
  sealSettingsSecrets,
  BackupFileError,
  readArchive,
  summarizeArchive
};
