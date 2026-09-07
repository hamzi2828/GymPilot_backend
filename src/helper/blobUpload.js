// src/helper/blobUpload.js
const { put, del } = require('@vercel/blob');
const { currentTenant } = require('../platform/tenantContext');

// Every gym's files sit under their own prefix in the store, named by the
// gym's slug, so listings and clean-ups can be scoped to one customer.
function tenantFolder(folder) {
  const gym = currentTenant();
  return gym && gym.slug ? `${gym.slug}/${folder}` : folder;
}

// Allowed image mime types
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

// File size limit (5MB)
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Upload a file buffer to Vercel Blob
 * @param {Buffer} buffer - File buffer
 * @param {string} filename - Original filename
 * @param {string} mimetype - File mimetype
 * @param {string} folder - Folder path (e.g., 'products', 'categories')
 * @returns {Promise<string>} - Public URL of uploaded file
 */
async function uploadToBlob(buffer, filename, mimetype, folder = 'uploads') {
  // Validate file type
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimetype)) {
    throw new Error('Only image files are allowed');
  }

  // Validate file size
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`);
  }

  // Generate unique filename
  const timestamp = Date.now();
  const rand = Math.round(Math.random() * 1e9);
  const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';
  const baseName = filename.replace(/\.[^/.]+$/, '').replace(/\s+/g, '-');
  const uniqueFilename = `${tenantFolder(folder)}/${timestamp}-${rand}-${baseName}.${ext}`;

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
 * @returns {Promise<string[]>} - Array of public URLs
 */
async function uploadMultipleToBlob(files, folder = 'uploads') {
  if (!files || !files.length) return [];

  const uploadPromises = files.map(file =>
    uploadToBlob(file.buffer, file.originalname, file.mimetype, folder)
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
 * Delete a file (works for both blob and local)
 * @param {string} url - URL or path of file to delete
 */
async function deleteFile(url) {
  if (!url) return;

  // If it's a blob URL, use deleteFromBlob
  if (url.includes('blob.vercel-storage.com')) {
    await deleteFromBlob(url);
  } else {
    // Local file - try to delete
    const fs = require('fs');
    const path = require('path');
    try {
      const localPath = url.startsWith('/uploads')
        ? path.join(__dirname, '../../..', url)
        : url;
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
      }
    } catch (error) {
      console.error('Failed to delete local file:', error);
    }
  }
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
  // Validate file type - allow all common image types
  if (!mimetype.startsWith('image/')) {
    throw new Error('Invalid file type. Only images are allowed.');
  }

  // Validate file size (10MB limit for screenshots)
  const SCREENSHOT_MAX_SIZE = 10 * 1024 * 1024;
  if (buffer.length > SCREENSHOT_MAX_SIZE) {
    throw new Error(`File size exceeds ${SCREENSHOT_MAX_SIZE / (1024 * 1024)}MB limit`);
  }

  // Generate unique filename
  const timestamp = Date.now();
  const rand = Math.round(Math.random() * 1e9);
  const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';
  const baseName = filename.replace(/\.[^/.]+$/, '').replace(/\s+/g, '-');
  const uniqueFilename = `${tenantFolder('screenshots')}/${timestamp}-${rand}-${baseName}.${ext}`;

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
  processProductFiles,
  processUploadedFiles,
  uploadScreenshot,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_FILE_SIZE,
};
