// src/helper/upload.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { currentTenant } = require('../platform/tenantContext');

// Configure uploads directory (fallback for local development)
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');

// Check if Vercel Blob is configured (skip local dir creation if using blob storage)
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

const NOT_WRITABLE_MESSAGE = 'File storage is not writable; set BLOB_READ_WRITE_TOKEN';

// Creates the uploads directory -- and a gym's folder inside it -- when a
// file is actually being written, never at require time. On a read-only
// filesystem (a serverless function, a container with a read-only root) the
// old startup mkdir only logged an error, and every later upload then died
// inside multer with an ENOENT that said nothing about the cause. Failing
// inside the request lets the error say what to do about it.
function ensureUploadsDir(folder = '') {
  if (USE_BLOB_STORAGE) return UPLOADS_DIR;
  const target = folder ? path.join(UPLOADS_DIR, folder) : UPLOADS_DIR;
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (cause) {
    const error = new Error(NOT_WRITABLE_MESSAGE);
    error.status = 500;
    error.code = 'UPLOADS_NOT_WRITABLE';
    error.cause = cause;
    throw error;
  }
  return target;
}

// Allowed image mime types. No SVG: an SVG is a document that can carry
// script, and these files are served back from our own origin.
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MB = 1024 * 1024;

// Vercel refuses any request body over 4.5 MB before this code ever runs,
// with an error page the browser cannot read. On Vercel every upload is
// therefore capped just under that, so the refusal is ours and says what to
// do about it. Anywhere else the full limits below apply.
const ON_VERCEL = !!process.env.VERCEL;
const VERCEL_MAX_FILE_BYTES = 4 * MB;
const platformCap = (bytes) => (ON_VERCEL ? Math.min(bytes, VERCEL_MAX_FILE_BYTES) : bytes);

// File size limit (default 5MB)
const MAX_FILE_MB = Number(process.env.UPLOAD_MAX_FILE_SIZE_MB || 5);
const MAX_FILE_BYTES = platformCap(Math.max(1, MAX_FILE_MB) * MB);

// Larger file size limit for blog hero images (20MB)
const MAX_HERO_FILE_MB = 20;
const MAX_HERO_FILE_BYTES = platformCap(MAX_HERO_FILE_MB * MB);

// Video uploads (homepage videos section)
const ALLOWED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
]);
const MAX_VIDEO_FILE_MB = Number(process.env.UPLOAD_MAX_VIDEO_SIZE_MB || 100);
const MAX_VIDEO_FILE_BYTES = platformCap(Math.max(1, MAX_VIDEO_FILE_MB) * MB);

// Member documents (10 MB) and CSV imports (5 MB).
const MAX_DOCUMENT_FILE_BYTES = platformCap(10 * MB);
const MAX_CSV_FILE_BYTES = platformCap(5 * MB);

// The extension a stored file gets, from the type the filter checked rather
// than from the name it arrived with: "logo.svg" sent as image/png is kept
// as .png, and so served as an image and never as a document.
const EXTENSION_FOR_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
};

function tooLargeMessage(maxBytes) {
  if (ON_VERCEL && maxBytes <= VERCEL_MAX_FILE_BYTES) {
    return "Files over 4 MB can't be uploaded — compress the image or use a video link.";
  }
  return `Files over ${Math.round(maxBytes / MB)} MB can't be uploaded — compress the file and try again.`;
}

// multer's size error would otherwise reach the global handler in index.js,
// which answers 400 and quotes the image limit whatever the route's own
// limit was. Answered here instead: a 413, naming the limit that applied.
function sizeLimited(middleware, maxBytes) {
  return function sizeLimitedUpload(req, res, next) {
    middleware(req, res, (error) => {
      if (error && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          code: 'FILE_TOO_LARGE',
          error: 'File too large',
          message: tooLargeMessage(maxBytes)
        });
      }
      return next(error);
    });
  };
}

// Each gym's files live in their own sub-folder, named by the gym's slug, so
// two gyms on one server never see or overwrite each other's uploads. The
// folder is part of `file.filename`, which is what every controller already
// turns into the public `/uploads/<filename>` path -- so the URLs they store
// come out as `/uploads/<slug>/<file>` without any of them changing.
function tenantUploadFolder(req) {
  const gym = (req && req.tenant) || currentTenant();
  return gym && gym.slug ? String(gym.slug) : '';
}

// Use memory storage for Vercel Blob, disk storage for local
const storage = USE_BLOB_STORAGE
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => {
        // Lazily, per request: see ensureUploadsDir. A failure here surfaces
        // through the global error handler as a 500 with a message that
        // names the fix.
        try {
          ensureUploadsDir(tenantUploadFolder(req));
        } catch (e) {
          return cb(e);
        }
        cb(null, UPLOADS_DIR);
      },
      filename: (req, file, cb) => {
        const timestamp = Date.now();
        // Unguessable, like the names helper/blobUpload.js gives the store:
        // these files are served by URL alone.
        const rand = crypto.randomBytes(16).toString('hex');
        const original = path.extname(file.originalname || '');
        const ext = EXTENSION_FOR_MIME[file.mimetype] || original.toLowerCase();
        const base = path.basename((file.originalname || 'file').replace(/\s+/g, '-'), original);
        const folder = tenantUploadFolder(req);
        cb(null, `${folder ? folder + '/' : ''}${timestamp}-${rand}-${base}${ext}`);
      },
    });

const fileFilter = (req, file, cb) => {
  if (ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) return cb(null, true);
  cb(new Error('Only image files are allowed'));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_BYTES } });

// Hero upload with larger file size limit
const heroUpload = multer({ storage, fileFilter, limits: { fileSize: MAX_HERO_FILE_BYTES } });

// Video upload (separate filter + much larger limit)
const videoFileFilter = (req, file, cb) => {
  if (ALLOWED_VIDEO_MIME_TYPES.has(file.mimetype)) return cb(null, true);
  cb(new Error('Only video files are allowed (mp4, webm, ogg, mov)'));
};
const videoUpload = multer({
  storage,
  fileFilter: videoFileFilter,
  limits: { fileSize: MAX_VIDEO_FILE_BYTES },
});

// CSV imports: always in memory (parsed, never stored), text only, 5 MB.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ok =
      /\.csv$/i.test(file.originalname || '') ||
      ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'].includes(file.mimetype);
    if (ok) return cb(null, true);
    cb(new Error('Only .csv files are accepted'));
  },
  limits: { fileSize: MAX_CSV_FILE_BYTES }
});
const csvUploadSingle = (fieldName) => sizeLimited(csvUpload.single(fieldName), MAX_CSV_FILE_BYTES);

// Member documents: signed forms, ID scans, medical letters. Images or
// PDFs, 10 MB.
const ALLOWED_DOCUMENT_MIME_TYPES = new Set([...ALLOWED_IMAGE_MIME_TYPES, 'application/pdf']);
const documentUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (ALLOWED_DOCUMENT_MIME_TYPES.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only image or PDF files are allowed'));
  },
  limits: { fileSize: MAX_DOCUMENT_FILE_BYTES }
});
const documentUploadSingle = (fieldName) => sizeLimited(documentUpload.single(fieldName), MAX_DOCUMENT_FILE_BYTES);

// The first bytes every allowed kind of file starts with. A type is only the
// browser's word; these say what the file really is.
function startsLike(head, mimetype) {
  const b = Buffer.isBuffer(head) ? head : Buffer.alloc(0);
  const at = (offset, text) => b.length >= offset + text.length && b.subarray(offset, offset + text.length).toString('latin1') === text;
  switch (mimetype) {
    case 'application/pdf': return at(0, '%PDF-');
    case 'image/jpeg': return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png': return at(0, '\x89PNG\r\n\x1a\n');
    case 'image/gif': return at(0, 'GIF87a') || at(0, 'GIF89a');
    case 'image/webp': return at(0, 'RIFF') && at(8, 'WEBP');
    default: return false;
  }
}

// The first bytes of an uploaded file, from memory or from disk.
function headOf(file, length = 16) {
  if (file.buffer) return file.buffer.subarray(0, length);
  if (!file.path) return Buffer.alloc(0);
  const fd = fs.openSync(file.path, 'r');
  try {
    const head = Buffer.alloc(length);
    const read = fs.readSync(fd, head, 0, length, 0);
    return head.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// Payment receipts: a photo or screenshot, or the PDF that Pakistani bank
// and wallet apps usually export. The same size limit as any other image,
// and the file's own first bytes must match the type it claims -- a "PDF"
// that is really something else is refused (and removed from disk).
const ALLOWED_PROOF_MIME_TYPES = new Set([...ALLOWED_IMAGE_MIME_TYPES, 'application/pdf']);
const PROOF_REFUSAL = 'Upload the receipt as a photo (JPG, PNG, WebP) or a PDF.';

/**
 * One file in `fieldName`, of the types in `mimes`, at most `maxBytes`, and
 * only when its own first bytes match the type it claims; anything else is
 * a 400 FILE_NOT_ALLOWED saying `refusal` (and a file on disk is removed).
 */
function checkedUploadSingle(fieldName, { mimes, maxBytes, refusal, notReal }) {
  const reader = multer({
    storage,
    fileFilter: (req, file, cb) => {
      if (mimes.has(file.mimetype)) return cb(null, true);
      const error = new Error(refusal);
      error.code = 'PROOF_TYPE_NOT_ALLOWED';
      cb(error);
    },
    limits: { fileSize: maxBytes }
  });
  const read = sizeLimited(reader.single(fieldName), maxBytes);
  return function uploadChecked(req, res, next) {
    read(req, res, (error) => {
      if (error && error.code === 'PROOF_TYPE_NOT_ALLOWED') {
        return res.status(400).json({ success: false, code: 'FILE_NOT_ALLOWED', message: refusal });
      }
      if (error) return next(error);
      const file = req.file;
      if (!file) return next();
      let ok = false;
      try {
        ok = startsLike(headOf(file), file.mimetype);
      } catch {
        ok = false;
      }
      if (ok) return next();
      if (file.path) fs.promises.unlink(file.path).catch(() => {});
      req.file = undefined;
      return res.status(400).json({ success: false, code: 'FILE_NOT_ALLOWED', message: `${notReal} ${refusal}` });
    });
  };
}

function proofUploadSingle(fieldName) {
  return checkedUploadSingle(fieldName, { mimes: ALLOWED_PROOF_MIME_TYPES, maxBytes: MAX_FILE_BYTES, refusal: PROOF_REFUSAL, notReal: 'That file does not look like a real photo or PDF.' });
}

// A gym's receipt for its GymsPilotPro subscription: a photo or a PDF, 4 MB
// at most wherever this runs (it is what Vercel would allow anyway).
const PLATFORM_RECEIPT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const PLATFORM_RECEIPT_MAX_BYTES = 4 * MB;
function platformReceiptUploadSingle(fieldName) {
  return checkedUploadSingle(fieldName, { mimes: PLATFORM_RECEIPT_MIME_TYPES, maxBytes: PLATFORM_RECEIPT_MAX_BYTES, refusal: PROOF_REFUSAL, notReal: 'That file does not look like a real photo or PDF.' });
}

// An image that is really one (a bank account's QR code): the image types
// above, at the image size limit.
function imageUploadChecked(fieldName) {
  return checkedUploadSingle(fieldName, { mimes: ALLOWED_IMAGE_MIME_TYPES, maxBytes: MAX_FILE_BYTES, refusal: 'Upload the image as a PNG, JPG, WebP or GIF.', notReal: 'That file does not look like a real image.' });
}

// Convenience wrappers
const uploadSingle =(fieldName) => sizeLimited(upload.single(fieldName), MAX_FILE_BYTES);
const uploadArray = (fieldName, maxCount) => sizeLimited(upload.array(fieldName, maxCount), MAX_FILE_BYTES);
const uploadFields = (fields) => sizeLimited(upload.fields(fields), MAX_FILE_BYTES);

// Hero upload wrappers
const heroUploadSingle = (fieldName) => sizeLimited(heroUpload.single(fieldName), MAX_HERO_FILE_BYTES);
const heroUploadFields = (fields) => sizeLimited(heroUpload.fields(fields), MAX_HERO_FILE_BYTES);

// Video upload wrapper
const videoUploadSingle = (fieldName) => sizeLimited(videoUpload.single(fieldName), MAX_VIDEO_FILE_BYTES);

// Helper to build public URL path (as served by Express static middleware)
function toPublicPath(filename) {
  // Returns a path like '/uploads/<slug>/<filename>'. The gym folder is part
  // of the multer filename, so only a leading slash or backslash is trimmed.
  return `/uploads/${String(filename).replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

// The absolute path on disk for a stored '/uploads/...' URL, or null when
// the URL is not one of ours or tries to escape the uploads directory.
// Every delete of a local upload goes through here: the old
// path.basename() approach dropped the gym folder and so deleted nothing.
function localUploadPath(publicUrl) {
  if (!publicUrl || typeof publicUrl !== 'string' || !publicUrl.startsWith('/uploads/')) return null;
  const relative = publicUrl.slice('/uploads/'.length).split('?')[0].split('#')[0];
  if (!relative) return null;
  const absolute = path.resolve(UPLOADS_DIR, relative);
  if (absolute !== UPLOADS_DIR && !absolute.startsWith(UPLOADS_DIR + path.sep)) return null;
  return absolute;
}

module.exports = {
  upload,
  uploadSingle,
  uploadArray,
  uploadFields,
  heroUploadSingle,
  heroUploadFields,
  videoUploadSingle,
  csvUploadSingle,
  documentUploadSingle,
  proofUploadSingle,
  platformReceiptUploadSingle,
  imageUploadChecked,
  PLATFORM_RECEIPT_MAX_BYTES,
  startsLike,
  ALLOWED_PROOF_MIME_TYPES,
  ensureUploadsDir,
  toPublicPath,
  localUploadPath,
  tenantUploadFolder,
  UPLOADS_DIR,
  NOT_WRITABLE_MESSAGE,
  MAX_FILE_BYTES,
  MAX_HERO_FILE_BYTES,
  MAX_VIDEO_FILE_BYTES,
  MAX_DOCUMENT_FILE_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
  EXTENSION_FOR_MIME,
  sizeLimited,
};
