// src/helper/upload.js
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { currentTenant } = require('../platform/tenantContext');

// Configure uploads directory (fallback for local development)
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads');

// Check if Vercel Blob is configured (skip local dir creation if using blob storage)
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;

function ensureUploadsDir() {
  // Skip directory creation on serverless/Lambda environments or when using blob storage
  if (USE_BLOB_STORAGE || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL) {
    return;
  }
  try {
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
  } catch (e) {
    console.error('Failed to create uploads directory:', e);
  }
}

ensureUploadsDir();

// Allowed image mime types
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

// File size limit (default 5MB)
const MAX_FILE_MB = Number(process.env.UPLOAD_MAX_FILE_SIZE_MB || 5);
const MAX_FILE_BYTES = Math.max(1, MAX_FILE_MB) * 1024 * 1024;

// Larger file size limit for blog hero images (20MB)
const MAX_HERO_FILE_MB = 20;
const MAX_HERO_FILE_BYTES = MAX_HERO_FILE_MB * 1024 * 1024;

// Video uploads (homepage videos section)
const ALLOWED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
]);
const MAX_VIDEO_FILE_MB = Number(process.env.UPLOAD_MAX_VIDEO_SIZE_MB || 100);
const MAX_VIDEO_FILE_BYTES = Math.max(1, MAX_VIDEO_FILE_MB) * 1024 * 1024;

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
        const folder = tenantUploadFolder(req);
        if (folder) {
          try {
            fs.mkdirSync(path.join(UPLOADS_DIR, folder), { recursive: true });
          } catch (e) {
            return cb(e);
          }
        }
        cb(null, UPLOADS_DIR);
      },
      filename: (req, file, cb) => {
        const timestamp = Date.now();
        const rand = Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname || '').toLowerCase();
        const base = path.basename((file.originalname || 'file').replace(/\s+/g, '-'), ext);
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
  limits: { fileSize: 5 * 1024 * 1024 }
});
const csvUploadSingle = (fieldName) => csvUpload.single(fieldName);

// Convenience wrappers
const uploadSingle = (fieldName) => upload.single(fieldName);
const uploadArray = (fieldName, maxCount) => upload.array(fieldName, maxCount);
const uploadFields = (fields) => upload.fields(fields);

// Hero upload wrappers
const heroUploadSingle = (fieldName) => heroUpload.single(fieldName);
const heroUploadFields = (fields) => heroUpload.fields(fields);

// Video upload wrapper
const videoUploadSingle = (fieldName) => videoUpload.single(fieldName);

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
  ensureUploadsDir,
  toPublicPath,
  localUploadPath,
  tenantUploadFolder,
  UPLOADS_DIR,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
};
