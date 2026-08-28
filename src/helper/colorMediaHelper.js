// src/helper/colorMediaHelper.js
const { toPublicPath } = require('./upload');

/**
 * Process color-specific media files and merge with existing colorMedia data
 * @param {Object} files - The uploaded files object from multer
 * @param {Object} colorMedia - Existing colorMedia object from the request body
 * @returns {Object} - Processed colorMedia object
 */
const processColorMedia = (files, colorMedia) => {
  // Parse colorMedia if it's a string
  if (typeof colorMedia === 'string') {
    try {
      colorMedia = JSON.parse(colorMedia);
    } catch (error) {
      console.error('Failed to parse colorMedia JSON:', error);
      colorMedia = {};
    }
  }

  // Initialize result object
  const processedColorMedia = {};
  
  // Get color-specific files
  const colorThumbFiles = Array.isArray(files?.colorThumbnail) ? files.colorThumbnail : [];
  const colorBannerFiles = Array.isArray(files?.colorBanner) ? files.colorBanner : [];
  
  // Process color thumbnails
  if (colorThumbFiles.length > 0) {
    console.log('Processing color thumbnails:', colorThumbFiles.length);
    colorThumbFiles.forEach(file => {
      // Extract color from filename (e.g., 'red-thumb.jpg')
      const filename = file.originalname;
      const colorMatch = filename.match(/^([^-]+)-thumb/);
      const color = colorMatch ? colorMatch[1] : 'unknown';
      
      if (!processedColorMedia[color]) {
        processedColorMedia[color] = {
          bannerUrls: [],
          thumbName: filename
        };
      }
      
      processedColorMedia[color].thumbnailUrl = toPublicPath(file.filename);
      console.log(`Processed color thumbnail for ${color}:`, file.filename);
    });
  }
  
  // Process color banners
  if (colorBannerFiles.length > 0) {
    console.log('Processing color banners:', colorBannerFiles.length);
    colorBannerFiles.forEach(file => {
      // Extract color from filename (e.g., 'red-banner-0.jpg')
      const filename = file.originalname;
      const colorMatch = filename.match(/^([^-]+)-banner/);
      const color = colorMatch ? colorMatch[1] : 'unknown';
      
      if (!processedColorMedia[color]) {
        processedColorMedia[color] = {
          bannerUrls: [],
          thumbName: `${color}-thumb.jpg`
        };
      }
      
      if (!Array.isArray(processedColorMedia[color].bannerUrls)) {
        processedColorMedia[color].bannerUrls = [];
      }
      
      processedColorMedia[color].bannerUrls.push(toPublicPath(file.filename));
      console.log(`Processed color banner for ${color}:`, file.filename);
    });
  }
  
  // Process existing colorMedia data
  if (colorMedia && typeof colorMedia === 'object') {
    Object.entries(colorMedia).forEach(([color, media]) => {
      if (!processedColorMedia[color]) {
        processedColorMedia[color] = {
          bannerUrls: media.bannerUrls || [],
          thumbName: media.thumbName || `${color}-thumb.jpg`
        };
      }
      
      // Keep existing thumbnailUrl if it's not a blob and we didn't get a new one
      if (!processedColorMedia[color].thumbnailUrl && media.thumbnailUrl && !media.thumbnailUrl.startsWith('blob:')) {
        processedColorMedia[color].thumbnailUrl = media.thumbnailUrl;
      }
      
      // Keep existing banner URLs that aren't blobs
      if (Array.isArray(media.bannerUrls)) {
        const nonBlobBanners = media.bannerUrls.filter(url => url && !url.startsWith('blob:'));
        if (nonBlobBanners.length > 0) {
          const existingBanners = processedColorMedia[color].bannerUrls || [];
          processedColorMedia[color].bannerUrls = [
            ...existingBanners,
            ...nonBlobBanners
          ];
        }
      }
    });
  }
  
  console.log('Final processed colorMedia:', JSON.stringify(processedColorMedia));
  return processedColorMedia;
};

module.exports = {
  processColorMedia
};
