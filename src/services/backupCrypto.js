// src/services/backupCrypto.js
//
// Stored backups are encrypted before they leave this server. They live in
// the Vercel Blob store, and every file there is public: the installed
// @vercel/blob (0.23) has no private access ("support for private blobs is
// planned"). A backup's URL is long and random, but a URL is not a secret --
// it ends up in logs and histories -- so what is stored must be unreadable
// without a key the store never sees.
//
// The key: BACKUP_ENCRYPTION_KEY, and nothing else. There is deliberately no
// fallback to JWT_SECRET or SETTINGS_ENCRYPTION_KEY: a backup has to open
// years from now, and rotating a session secret must never be what makes
// every stored backup unreadable. Without it, nothing is stored (the daily
// job skips every gym and says why, Settings → Data & backup says so too);
// the owner's own download needs no key and keeps working. Change it and
// the backups made with the old one can no longer be opened -- each file
// carries a short key id, so that case is reported as such, not as damage.
//
// From it, per gym: scrypt(BACKUP_ENCRYPTION_KEY, salt carrying the gym id)
// -- a file lifted from one gym cannot be opened as another's -- and per
// file: HKDF of that with 32 random bytes kept in the file's header. Every
// file thus has its own AES-256-GCM key, and its nonces are just a counter.
//
// The file (all integers big-endian):
//
//   'GPBKENC1'  8 bytes   what this is
//   version     1 byte    1
//   key id      8 bytes   HMAC of the gym key, to tell "wrong key" apart
//   salt        32 bytes  this file's key = HKDF(gym key, salt)
//   chunks      each 1 MiB of plaintext (the last may be shorter, even
//               empty) sealed on its own: ciphertext + 16-byte tag, with
//               nonce = 7 zero bytes | chunk number (4) | 1 on the last
//               chunk, else 0; the 49-byte header is the additional data
//
// Chunked rather than one GCM stream so nothing is released before it has
// been authenticated: a restore reads a backup as a stream and must never
// write a byte that has not been checked. The last-chunk flag means a file
// cut at a chunk boundary fails too. The browser writes the same format when
// the owner uploads a backup to restore (Settings → Data & backup), with a
// file key this server derives and hands it for that one upload.

const crypto = require('crypto');
const { Transform } = require('stream');

const MAGIC = Buffer.from('GPBKENC1', 'ascii');
const VERSION = 1;
const HEADER_BYTES = MAGIC.length + 1 + 8 + 32;
const CHUNK_BYTES = 1024 * 1024;
const TAG_BYTES = 16;
const KEY_SALT = 'gympilot.backup.v1';
const FILE_INFO = Buffer.from('gympilot backup file', 'utf8');

/** A backup that cannot be opened. `message` is fit to show. */
class BackupCryptoError extends Error {
  constructor(message, code = 'BACKUP_UNREADABLE') {
    super(message);
    this.name = 'BackupCryptoError';
    this.code = code;
    this.status = 400;
  }
}

function secret(env = process.env) {
  return String(env.BACKUP_ENCRYPTION_KEY || '');
}

/** Whether stored backups can be made (and opened) on this server. */
function keyConfigured(env = process.env) {
  return secret(env).length > 0;
}

const gymKeys = new Map(); // `${secret}\n${gymId}` -> Buffer

function gymKey(gymId) {
  const value = secret();
  if (!value) throw new BackupCryptoError('Stored backups are off: BACKUP_ENCRYPTION_KEY is not set on the server.', 'BACKUP_KEY_MISSING');
  if (!gymId) throw new Error('[backup] a gym id is needed to derive its backup key');
  const cacheKey = `${value}\n${gymId}`;
  let key = gymKeys.get(cacheKey);
  if (!key) {
    key = crypto.scryptSync(value, `${KEY_SALT}:${gymId}`, 32);
    gymKeys.set(cacheKey, key);
  }
  return key;
}

function keyIdOf(key) {
  return crypto.createHmac('sha256', key).update('gympilot backup key id').digest().subarray(0, 8);
}

function fileKeyOf(key, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', key, salt, FILE_INFO, 32));
}

function nonceFor(counter, last) {
  const nonce = Buffer.alloc(12, 0);
  nonce.writeUInt32BE(counter, 7);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

/**
 * A fresh file key for `gymId`: the 49-byte header that must start the file,
 * and the AES key its chunks are sealed with. Used by the encrypting stream
 * below, and handed (key and header only, for one upload) to the browser
 * that encrypts a backup the owner uploads.
 */
function newFileKey(gymId) {
  const key = gymKey(gymId);
  const salt = crypto.randomBytes(32);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), keyIdOf(key), salt]);
  return { header, fileKey: fileKeyOf(key, salt) };
}

// A queue of buffers read from the front, without concatenating everything
// that arrives.
class ByteQueue {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  push(buffer) {
    if (buffer.length) {
      this.parts.push(buffer);
      this.length += buffer.length;
    }
  }

  take(count) {
    const out = Buffer.allocUnsafe(count);
    let filled = 0;
    while (filled < count) {
      const head = this.parts[0];
      const need = count - filled;
      if (head.length <= need) {
        head.copy(out, filled);
        filled += head.length;
        this.parts.shift();
      } else {
        head.copy(out, filled, 0, need);
        this.parts[0] = head.subarray(need);
        filled += need;
      }
    }
    this.length -= count;
    return out;
  }
}

/** A Transform that encrypts what passes through it for `gymId`'s storage. */
function encryptStream(gymId) {
  const { header, fileKey } = newFileKey(gymId);
  const queue = new ByteQueue();
  let counter = 0;
  let started = false;

  const seal = (plain, last) => {
    const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, nonceFor(counter, last));
    cipher.setAAD(header);
    const out = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    counter += 1;
    return out;
  };

  return new Transform({
    transform(chunk, _encoding, done) {
      if (!started) {
        this.push(header);
        started = true;
      }
      queue.push(chunk);
      // A chunk goes out once more is known to follow, so the last one --
      // flagged as such -- is always the one left at the end.
      while (queue.length > CHUNK_BYTES) this.push(seal(queue.take(CHUNK_BYTES), false));
      done();
    },
    flush(done) {
      if (!started) this.push(header);
      this.push(seal(queue.take(queue.length), true));
      done();
    }
  });
}

/**
 * A Transform that opens a stored (or uploaded) backup for `gymId` and
 * passes on only authenticated bytes. Errors -- not ours, another key,
 * another gym, damaged, cut short -- are BackupCryptoError.
 */
function decryptStream(gymId) {
  const queue = new ByteQueue();
  let header = null;
  let fileKey = null;
  let counter = 0;

  const open = (sealed, last) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, nonceFor(counter, last));
    decipher.setAAD(header);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    let plain;
    try {
      plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
    } catch {
      // The key is right (the header said so), so the bytes are not.
      throw new BackupCryptoError('This backup could not be opened: it is damaged or incomplete.');
    }
    counter += 1;
    return plain;
  };

  const readHeader = () => {
    const bytes = queue.take(HEADER_BYTES);
    if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupCryptoError('This file is not an encrypted GymPilot backup.');
    }
    if (bytes[MAGIC.length] !== VERSION) {
      throw new BackupCryptoError('This backup was made by a newer version of GymPilot and cannot be opened here.');
    }
    const key = gymKey(gymId);
    if (!bytes.subarray(MAGIC.length + 1, MAGIC.length + 9).equals(keyIdOf(key))) {
      throw new BackupCryptoError(
        'This backup cannot be opened with this server\'s key: it belongs to another gym, or it was made before BACKUP_ENCRYPTION_KEY was changed.',
        'BACKUP_WRONG_KEY'
      );
    }
    header = bytes;
    fileKey = fileKeyOf(key, bytes.subarray(MAGIC.length + 9));
  };

  return new Transform({
    transform(chunk, _encoding, done) {
      try {
        queue.push(chunk);
        if (!header && queue.length >= HEADER_BYTES) readHeader();
        if (header) {
          while (queue.length > CHUNK_BYTES + TAG_BYTES) this.push(open(queue.take(CHUNK_BYTES + TAG_BYTES), false));
        }
        done();
      } catch (error) {
        done(error);
      }
    },
    flush(done) {
      try {
        if (!header) {
          throw new BackupCryptoError(queue.length ? 'This file is not an encrypted GymPilot backup.' : 'This backup is empty.');
        }
        if (queue.length < TAG_BYTES) throw new BackupCryptoError('This backup could not be opened: it is damaged or incomplete.');
        this.push(open(queue.take(queue.length), true));
        done();
      } catch (error) {
        done(error);
      }
    }
  });
}

module.exports = {
  CHUNK_BYTES,
  HEADER_BYTES,
  TAG_BYTES,
  BackupCryptoError,
  keyConfigured,
  newFileKey,
  encryptStream,
  decryptStream
};
