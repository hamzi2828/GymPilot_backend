// src/controller/homeSectionController.js
//
// Homepage section management. Public read for the storefront, admin write
// for the /admin/homepage page.

const HomeSection = require('../models/homeSectionModel');

// Check if Vercel Blob is configured (same convention as the other uploads)
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

const isKnownKey = (key) => HomeSection.SECTION_KEYS.includes(key);

// The gallery originally stored a flat `images` list plus a feature video.
// It now stores named sub-sections (`groups`). Old documents are converted on
// read so both the site and the admin editor always see the new shape; the
// next admin save then persists it.
function normalizeSection(section) {
  if (!section || section.key !== 'gallery') return section;
  const content = section.content || {};
  const hasGroups = Array.isArray(content.groups) && content.groups.length > 0;
  if (hasGroups) return section;
  if (Array.isArray(content.images) && content.images.length > 0) {
    const { images, videoUrl, videoPoster, ...rest } = content;
    return {
      ...section,
      content: { ...rest, groups: [{ title: 'Gallery', images }] },
    };
  }
  return section;
}

const homeSectionController = {
  // GET /home-sections/public — enabled sections, in display order.
  // Keys are whitelisted: the same collection may hold documents from older
  // storefront experiments, which must never surface here or in the admin.
  getPublicSections: async (req, res) => {
    try {
      await HomeSection.ensureDefaults();
      const sections = await HomeSection.find({
        enabled: true,
        key: { $in: HomeSection.SECTION_KEYS },
      })
        .sort({ order: 1, key: 1 })
        .select('key enabled order content updatedAt')
        .lean();

      return res.status(200).json({ success: true, data: sections.map(normalizeSection) });
    } catch (error) {
      console.error('Error fetching public home sections:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch home sections',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // GET /home-sections — every known section, including disabled ones (admin).
  getAllSections: async (req, res) => {
    try {
      await HomeSection.ensureDefaults();
      const sections = await HomeSection.find({ key: { $in: HomeSection.SECTION_KEYS } })
        .sort({ order: 1, key: 1 })
        .lean();
      return res.status(200).json({ success: true, data: sections.map(normalizeSection) });
    } catch (error) {
      console.error('Error fetching home sections:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch home sections',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // PUT /home-sections/:key — replace a section's content and/or enabled flag.
  updateSection: async (req, res) => {
    try {
      const { key } = req.params;
      if (!isKnownKey(key)) {
        return res.status(404).json({ success: false, message: `Unknown section '${key}'` });
      }

      const update = {};
      if (req.body.enabled !== undefined) {
        update.enabled = req.body.enabled === true || req.body.enabled === 'true';
      }
      if (req.body.content !== undefined) {
        let content = req.body.content;
        // The admin UI sends JSON, but tolerate a stringified payload too.
        if (typeof content === 'string') {
          try {
            content = JSON.parse(content);
          } catch {
            return res.status(400).json({ success: false, message: 'content must be valid JSON' });
          }
        }
        if (typeof content !== 'object' || content === null || Array.isArray(content)) {
          return res.status(400).json({ success: false, message: 'content must be an object' });
        }
        update.content = content;
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ success: false, message: 'Nothing to update' });
      }

      await HomeSection.ensureDefaults();
      const section = await HomeSection.findOneAndUpdate(
        { key },
        { $set: update },
        { new: true, runValidators: true }
      );

      return res.status(200).json({
        success: true,
        message: 'Section updated successfully',
        data: section,
      });
    } catch (error) {
      console.error('Error updating home section:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to update section',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // PATCH /home-sections/:key/status — flip a section's visibility.
  toggleSection: async (req, res) => {
    try {
      const { key } = req.params;
      if (!isKnownKey(key)) {
        return res.status(404).json({ success: false, message: `Unknown section '${key}'` });
      }

      await HomeSection.ensureDefaults();
      const section = await HomeSection.findOne({ key });
      section.enabled = !section.enabled;
      await section.save();

      return res.status(200).json({
        success: true,
        message: `Section ${section.enabled ? 'enabled' : 'disabled'}`,
        data: section,
      });
    } catch (error) {
      console.error('Error toggling home section:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to toggle section',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // PUT /home-sections/reorder — body: { order: [{ key, order }] }
  reorderSections: async (req, res) => {
    try {
      const { order } = req.body;
      if (!Array.isArray(order) || order.length === 0) {
        return res.status(400).json({ success: false, message: 'order must be a non-empty array' });
      }
      for (const item of order) {
        if (!item || !isKnownKey(item.key) || typeof item.order !== 'number') {
          return res.status(400).json({
            success: false,
            message: 'Each item needs a known section key and a numeric order',
          });
        }
      }

      await HomeSection.bulkWrite(
        order.map((item) => ({
          updateOne: {
            filter: { key: item.key },
            update: { $set: { order: item.order } },
          },
        }))
      );

      const sections = await HomeSection.find({ key: { $in: HomeSection.SECTION_KEYS } })
        .sort({ order: 1, key: 1 })
        .lean();
      return res.status(200).json({
        success: true,
        message: 'Section order updated',
        data: sections.map(normalizeSection),
      });
    } catch (error) {
      console.error('Error reordering home sections:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to reorder sections',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // POST /home-sections/upload — generic admin image upload; returns the URL
  // to store inside a section's content (gallery tiles, card images, …).
  uploadImage: async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'Image file is required' });
      }

      let url;
      if (USE_BLOB_STORAGE && blobUpload) {
        url = await blobUpload.uploadToBlob(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype,
          'home-sections'
        );
      } else {
        url = `/uploads/${req.file.filename}`;
      }

      return res.status(201).json({ success: true, data: { url } });
    } catch (error) {
      console.error('Error uploading home section image:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload image',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },

  // POST /home-sections/upload-video — video clip for the homepage videos
  // section; returns the URL to store in that section's content.
  uploadVideo: async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'Video file is required' });
      }

      let url;
      if (USE_BLOB_STORAGE && blobUpload) {
        url = await blobUpload.uploadToBlob(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype,
          'home-videos'
        );
      } else {
        url = `/uploads/${req.file.filename}`;
      }

      return res.status(201).json({ success: true, data: { url } });
    } catch (error) {
      console.error('Error uploading home section video:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload video',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  },
};

module.exports = homeSectionController;
