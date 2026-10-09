// src/helper/blobUpload.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { put, del } = require('@vercel/blob');
const { currentTenant } = require('../platform/tenantContext');
const { EXTENSION_FOR_MIME, UPLOADS_DIR, localUploadPath } = require('./upload');

// Every gym's files sit under their own prefix in the store, named by the
// gym's slug, so listings and clean-ups can be scoped to one customer.
function folderFor(slug, folder) {
  return slug ? `${slug}/${folder}` : folder;
}

function tenantFolder(folder) {
  const gym = currentTenant();
  return folderFor(gym && gym.slug, folder);
}

// The store is public: whoever has a file's URL can open it, and an ID scan
// or a medical letter has nothing else in front of it. So the URL has to be
// the secret -- 128 bits from the system's random source in every stored
// name, where a timestamp and Math.random() could be worked out.
function unguessable() {
  return crypto.randomBytes(16).toString('hex');
}

// Where the store serves public files from: <store id> + this suffix.
const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';

/**
 * A URL the browser says it uploaded straight to the store (see
 * controller/uploadController.js), returned without query or fragment when
 * it is an https file on the Blob host under this gym's `<slug>/<folder>/`;
 * otherwise null. The check is on the parsed path, so `..` segments are
 * already resolved and cannot climb into another gym's folder.
 * @param {string} value - the URL as submitted
 * @param {string} slug - the gym's slug ('' outside a gym, as tenantFolder)
 * @param {string} folder - e.g. 'hero-slides'
 * @returns {string|null}
 */
function ownBlobUrl(value, slug, folder) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(BLOB_HOST_SUFFIX) || host.length === BLOB_HOST_SUFFIX.length) return null;
  const prefix = `/${folderFor(slug, folder)}/`;
  if (!url.pathname.startsWith(prefix) || url.pathname.length === prefix.length) return null;
  return `${url.origin}${url.pathname}`;
}

// What may be stored, by kind. Images are what every caller originally sent
// and remain the default; member documents (signed forms, ID scans, medical
// letters) and homepage videos each have their own set and ceiling. The
// multer filters in helper/upload.js gate the same kinds on the way in; this
// is the check on the way out to the store, which is the one that actually
// costs money to get wrong.
const MB = 1024 * 1024;

// No SVG: it is a document that can carry script, and a stored one would be
// served back to anyone who opens its URL.
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const ALLOWED_DOCUMENT_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const ALLOWED_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

// Image ceiling honours the same setting the multer limit does.
const MAX_FILE_SIZE = Math.max(1, Number(process.env.UPLOAD_MAX_FILE_SIZE_MB || 5)) * MB;
const MAX_DOCUMENT_SIZE = 10 * MB;
const MAX_VIDEO_SIZE = Math.max(1, Number(process.env.UPLOAD_MAX_VIDEO_SIZE_MB || 100)) * MB;

const KINDS = {
  image: { mimes: ALLOWED_IMAGE_MIME_TYPES, maxBytes: MAX_FILE_SIZE, refusal: 'Only image files are allowed' },
  document: { mimes: ALLOWED_DOCUMENT_MIME_TYPES, maxBytes: MAX_DOCUMENT_SIZE, refusal: 'Only PDF, JPEG or PNG files are allowed' },
  video: { mimes: ALLOWED_VIDEO_MIME_TYPES, maxBytes: MAX_VIDEO_SIZE, refusal: 'Only video files are allowed (mp4, webm, mov)' },
};

// When a caller says nothing about the kind, the mimetype decides: a PDF is
// a document and an mp4 is a video whoever sent it, so the callers written
// before kinds existed keep working without being touched.
function inferKind(mimetype) {
  const type = String(mimetype || '').toLowerCase();
  if (type.startsWith('video/')) return 'video';
  if (type === 'application/pdf') return 'document';
  return 'image';
}

/**
 * Upload a file buffer to Vercel Blob
 * @param {Buffer} buffer - File buffer
 * @param {string} filename - Original filename
 * @param {string} mimetype - File mimetype
 * @param {string} folder - Folder path (e.g., 'products', 'categories')
 * @param {object} [options]
 * @param {'image'|'document'|'video'} [options.kind]  what is being stored; inferred from the mimetype when absent
 * @param {number} [options.maxBytes]  a caller's own ceiling (hero images may be larger than the default)
 * @returns {Promise<string>} - Public URL of uploaded file
 */
async function uploadToBlob(buffer, filename, mimetype, folder = 'uploads', options = {}) {
  const kind = options && KINDS[options.kind] ? options.kind : inferKind(mimetype);
  const rule = KINDS[kind];

  // Validate file type
  if (!rule.mimes.has(mimetype)) {
    throw new Error(rule.refusal);
  }

  // Validate file size
  if (!buffer || !buffer.length) {
    throw new Error('The uploaded file is empty');
  }
  const maxBytes = options && Number(options.maxBytes) > 0 ? Number(options.maxBytes) : rule.maxBytes;
  if (buffer.length > maxBytes) {
    throw new Error(`File size exceeds ${Math.round(maxBytes / MB)}MB limit`);
  }

  // Generate unique filename. The extension follows the type checked above,
  // not the name the file arrived with ("logo.svg" sent as image/png is
  // stored as .png).
  const timestamp = Date.now();
  const ext = (EXTENSION_FOR_MIME[mimetype] || '').slice(1) || filename.split('.').pop()?.toLowerCase() || 'jpg';
  const baseName = filename.replace(/\.[^/.]+$/, '').replace(/\s+/g, '-');
  const uniqueFilename = `${tenantFolder(folder)}/${timestamp}-${unguessable()}-${baseName}.${ext}`;

  // Upload to Vercel Blob
  const { url } = await put(uniqueFilename, buffer, {
    access: 'public',
    contentType: mimetype,
  });

  return url;
}

/**
 * Upload multiple files to Vercel Blob
 * @param {Array} files - Array of file objects from multer
 * @param {string} folder - Folder path
 * @param {object} [options] - passed through to uploadToBlob (kind, maxBytes)
 * @returns {Promise<string[]>} - Array of public URLs
 */
async function uploadMultipleToBlob(files, folder = 'uploads', options = {}) {
  if (!files || !files.length) return [];

  const uploadPromises = files.map(file =>
    uploadToBlob(file.buffer, file.originalname, file.mimetype, folder, options)
  );

  return Promise.all(uploadPromises);
}

/**
 * Delete a file from Vercel Blob
 * @param {string} url - Full URL of the blob to delete
 */
async function deleteFromBlob(url) {
  if (!url) return;

  try {
    await del(url);
  } catch (error) {
    console.error('Failed to delete blob:', error);
  }
}

/**
 * Process generic uploaded files and return blob URLs
 * @param {Object} files - Files object from multer (memory storage)
 * @param {string} folder - Base folder for uploads
 * @returns {Promise<Object>} - Object with processed URLs by field name
 */
async function processUploadedFiles(files, folder = 'uploads') {
  const result = {};

  for (const fieldName in files) {
    const fieldFiles = files[fieldName];
    if (fieldFiles && fieldFiles.length) {
      if (fieldFiles.length === 1) {
        // Single file - return string
        const file = fieldFiles[0];
        result[fieldName] = await uploadToBlob(
          file.buffer,
          file.originalname,
          file.mimetype,
          `${folder}/${fieldName}`
        );
      } else {
        // Multiple files - return array
        result[fieldName] = await uploadMultipleToBlob(fieldFiles, `${folder}/${fieldName}`);
      }
    }
  }

  return result;
}

/**
 * Delete one stored file of the gym this request is for: a Blob URL or a
 * local '/uploads/...' path. Nothing outside the gym's own folder is ever
 * touched -- another gym's file, an avatar hosted by Google, a path that
 * climbs out of the uploads directory are all left alone -- and a file that
 * is already gone is not an error. Never throws: a file left behind must not
 * fail the request that no longer needs it.
 * @param {string} url - the URL or '/uploads/...' path as stored
 * @param {string} [folder] - the folder it was stored in ('member-documents').
 *   In the Blob store the file must be under `<slug>/<folder>/`; local files
 *   are not kept in folders, so there it only has to be the gym's.
 * @returns {Promise<boolean>} whether a file of this gym was removed (or was
 *   already gone)
 */
async function deleteStoredFile(url, folder = '') {
  const gym = currentTenant();
  const slug = gym && gym.slug ? String(gym.slug) : '';
  if (typeof url !== 'string' || !url || !slug) return false;

  try {
    if (url.startsWith('/uploads/')) {
      const local = localUploadPath(url);
      if (!local || !local.startsWith(path.join(UPLOADS_DIR, slug) + path.sep)) return false;
      await fs.promises.unlink(local);
      return true;
    }
    // With no folder named, anywhere under the gym's own prefix will do.
    const own = folder ? ownBlobUrl(url, slug, folder) : ownBlobUrl(url, '', slug);
    if (!own) return false;
    await del(own);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    console.error('Failed to delete a stored file:', error.message);
    return false;
  }
}

/**
 * Delete a file (works for both blob and local)
 * @param {string} url - URL or path of file to delete
 */
async function deleteFile(url) {
  await deleteStoredFile(url);
}

/**
 * Process uploaded files and return blob URLs
 * @param {Object} files - Files object from multer (memory storage)
 * @returns {Promise<Object>} - Object with processed URLs
 */
async function processProductFiles(files) {
  const result = {
    thumbnailUrl: null,
    bannerUrls: [],
    colorMedia: {},
    customSizeGuideUrl: null,
  };

  // Process main thumbnail
  if (files.thumbnail && files.thumbnail[0]) {
    const file = files.thumbnail[0];
    result.thumbnailUrl = await uploadToBlob(
      file.buffer,
      file.originalname,
      file.mimetype,
      'products/thumbnails'
    );
  }

  // Process banners
  if (files.banners && files.banners.length) {
    result.bannerUrls = await uploadMultipleToBlob(files.banners, 'products/banners');
  }

  // Process color thumbnails
  if (files.colorThumbnail && files.colorThumbnail.length) {
    for (const file of files.colorThumbnail) {
      // Extract color from filename (format: color_originalname.ext)
      const colorMatch = file.originalname.match(/^([^_]+)_/);
      if (colorMatch) {
        const color = colorMatch[1];
        if (!result.colorMedia[color]) {
          result.colorMedia[color] = { thumbnailUrl: null, bannerUrls: [] };
        }
        result.colorMedia[color].thumbnailUrl = await uploadToBlob(
          file.buffer,
          file.originalname,
          file.mimetype,
          `products/colors/${color}`
        );
      }
    }
  }

  // Process color banners
  if (files.colorBanner && files.colorBanner.length) {
    for (const file of files.colorBanner) {
      const colorMatch = file.originalname.match(/^([^_]+)_/);
      if (colorMatch) {
        const color = colorMatch[1];
        if (!result.colorMedia[color]) {
          result.colorMedia[color] = { thumbnailUrl: null, bannerUrls: [] };
        }
        const url = await uploadToBlob(
          file.buffer,
          file.originalname,
          file.mimetype,
          `products/colors/${color}`
        );
        result.colorMedia[color].bannerUrls.push(url);
      }
    }
  }

  // Process custom size guide image
  if (files.customSizeGuideImage && files.customSizeGuideImage[0]) {
    const file = files.customSizeGuideImage[0];
    result.customSizeGuideUrl = await uploadToBlob(
      file.buffer,
      file.originalname,
      file.mimetype,
      'products/size-guides'
    );
  }

  return result;
}

/**
 * Upload screenshot/image to Vercel Blob (accepts all image types)
 * @param {Buffer} buffer - File buffer
 * @param {string} filename - Original filename
 * @param {string} mimetype - File mimetype
 * @returns {Promise<string>} - Public URL of uploaded file
 */
async function uploadScreenshot(buffer, filename, mimetype) {
  // Validate file type - allow all common image types except SVG, which can
  // carry script (see ALLOWED_IMAGE_MIME_TYPES above)
  if (!mimetype.startsWith('image/') || mimetype === 'image/svg+xml') {
    throw new Error('Invalid file type. Only images are allowed.');
  }

  // Validate file size (10MB limit for screenshots)
  const SCREENSHOT_MAX_SIZE = 10 * 1024 * 1024;
  if (buffer.length > SCREENSHOT_MAX_SIZE) {
    throw new Error(`File size exceeds ${SCREENSHOT_MAX_SIZE / (1024 * 1024)}MB limit`);
  }

  // Generate unique filename
  const timestamp = Date.now();
  const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';
  const baseName = filename.replace(/\.[^/.]+$/, '').replace(/\s+/g, '-');
  const uniqueFilename = `${tenantFolder('screenshots')}/${timestamp}-${unguessable()}-${baseName}.${ext}`;

  // Upload to Vercel Blob
  const { url } = await put(uniqueFilename, buffer, {
    access: 'public',
    contentType: mimetype,
  });

  return url;
}

module.exports = {
  uploadToBlob,
  uploadMultipleToBlob,
  deleteFromBlob,
  deleteFile,
  deleteStoredFile,
  processProductFiles,
  processUploadedFiles,
  uploadScreenshot,
  inferKind,
  folderFor,
  ownBlobUrl,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_DOCUMENT_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_DOCUMENT_SIZE,
  MAX_VIDEO_SIZE,
};
