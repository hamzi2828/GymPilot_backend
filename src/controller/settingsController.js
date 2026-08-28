// src/controller/settingsController.js

const Settings = require('../models/settings');
const fs = require('fs').promises;
const path = require('path');

// Check if Vercel Blob is configured
const USE_BLOB_STORAGE = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobUpload;
if (USE_BLOB_STORAGE) {
  blobUpload = require('../helper/blobUpload');
}

const settingsController = {
  // GET /settings/public - Get public settings (no auth required)
  getPublicSettings: async (req, res) => {
    try {
      const settings = await Settings.getSettings();

      // Return only public-safe settings
      const publicSettings = {
        siteName: settings.siteName,
        siteUrl: settings.siteUrl,
        logoUrl: settings.logoUrl,
        logoWidth: settings.logoWidth || 160,
        logoHeight: settings.logoHeight || 56,
        footerLogoUrl: settings.footerLogoUrl || '',
        footerLogoWidth: settings.footerLogoWidth || 120,
        footerLogoHeight: settings.footerLogoHeight || 40,
        mobileNumber: settings.mobileNumber || '',
        address: settings.address || '',
        currency: settings.currency,
        taxRate: settings.taxRate || 0,
        topSliderText: settings.topSliderText || '',
        youtubeUrl: settings.youtubeUrl,
        facebookUrl: settings.facebookUrl,
        instagramUrl: settings.instagramUrl,
        twitterUrl: settings.twitterUrl,
        tiktokUrl: settings.tiktokUrl
      };

      return res.status(200).json({
        success: true,
        data: publicSettings
      });
    } catch (error) {
      console.error('Get public settings error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve settings',
        error: error.message
      });
    }
  },

  // GET /settings - Get current settings
  getSettings: async (req, res) => {
    try {
      const settings = await Settings.getSettings();
      
      return res.status(200).json({
        success: true,
        message: 'Settings retrieved successfully',
        data: settings
      });
    } catch (error) {
      console.error('Get settings error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve settings',
        error: error.message
      });
    }
  },

  // PUT /settings - Update settings
  updateSettings: async (req, res) => {
    try {
      console.log('Request body:', req.body);

      const {
        siteName,
        siteUrl,
        mobileNumber,
        address,
        timezone,
        dateFormat,
        emailNotifications,
        marketingEmails,
        securityAlerts,
        twoFactorAuth,
        currency,
        taxRate,
        paymentMethods,
        topSliderText,
        logoWidth,
        logoHeight,
        footerLogoWidth,
        footerLogoHeight,
        youtubeUrl,
        facebookUrl,
        instagramUrl,
        twitterUrl,
        tiktokUrl
      } = req.body;

      // Prepare update data with only provided fields
      const updateData = {};

      // Update only provided fields
      if (siteName !== undefined) updateData.siteName = siteName.trim();
      if (siteUrl !== undefined) updateData.siteUrl = siteUrl.trim();
      if (mobileNumber !== undefined) updateData.mobileNumber = mobileNumber.trim();
      if (address !== undefined) updateData.address = address.trim();
      if (timezone !== undefined) updateData.timezone = timezone;
      if (dateFormat !== undefined) updateData.dateFormat = dateFormat;
      if (emailNotifications !== undefined) updateData.emailNotifications = Boolean(emailNotifications);
      if (marketingEmails !== undefined) updateData.marketingEmails = Boolean(marketingEmails);
      if (securityAlerts !== undefined) updateData.securityAlerts = Boolean(securityAlerts);
      if (twoFactorAuth !== undefined) updateData.twoFactorAuth = Boolean(twoFactorAuth);
      if (currency !== undefined) updateData.currency = currency;
      if (taxRate !== undefined) updateData.taxRate = Number(taxRate);
      if (topSliderText !== undefined) updateData.topSliderText = topSliderText.trim();
      if (logoWidth !== undefined) updateData.logoWidth = Number(logoWidth);
      if (logoHeight !== undefined) updateData.logoHeight = Number(logoHeight);
      if (footerLogoWidth !== undefined) updateData.footerLogoWidth = Number(footerLogoWidth);
      if (footerLogoHeight !== undefined) updateData.footerLogoHeight = Number(footerLogoHeight);

      // Handle social links
      if (youtubeUrl !== undefined) updateData.youtubeUrl = youtubeUrl;
      if (facebookUrl !== undefined) updateData.facebookUrl = facebookUrl;
      if (instagramUrl !== undefined) updateData.instagramUrl = instagramUrl;
      if (twitterUrl !== undefined) updateData.twitterUrl = twitterUrl;
      if (tiktokUrl !== undefined) updateData.tiktokUrl = tiktokUrl;

      // Handle payment methods array
      if (paymentMethods && Array.isArray(paymentMethods)) {
        updateData.paymentMethods = paymentMethods.filter(method =>
          ['credit_card', 'paypal', 'stripe', 'razorpay'].includes(method)
        );
      }

      // Ensure we have some data to update
      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No valid fields provided for update'
        });
      }

      // Update settings
      const updatedSettings = await Settings.updateSettings(updateData);

      return res.status(200).json({
        success: true,
        message: 'Settings updated successfully',
        data: updatedSettings
      });
    } catch (error) {
      console.error('Update settings error:', error);
      
      if (error.name === 'ValidationError') {
        return res.status(400).json({
          success: false,
          message: 'Validation error',
          error: error.message
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Failed to update settings',
        error: error.message
      });
    }
  },

  // POST /settings/logo - Upload logo
  uploadLogo: async (req, res) => {
    try {
      const logoFile = req.files?.logo?.[0];
      
      if (!logoFile) {
        return res.status(400).json({
          success: false,
          message: 'Logo file is required'
        });
      }

      // Validate file type
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(logoFile.mimetype)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid file type. Please upload PNG, JPG, GIF, or WebP images only.'
        });
      }

      // Validate file size (5MB)
      if (logoFile.size > 5 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          message: 'File size too large. Maximum size allowed is 5MB.'
        });
      }

      // Generate new logo URL
      let logoUrl;
      if (USE_BLOB_STORAGE && blobUpload) {
        logoUrl = await blobUpload.uploadToBlob(
          logoFile.buffer, logoFile.originalname, logoFile.mimetype, 'settings'
        );
      } else {
        logoUrl = `/uploads/${logoFile.filename}`;
      }

      // Get current settings to backup old logo
      const currentSettings = await Settings.getSettings();
      const oldLogoUrl = currentSettings.logoUrl;

      // Update settings with new logo URL
      const updatedSettings = await Settings.updateSettings({ logoUrl });

      // Remove old logo file if it exists and is not the default
      if (oldLogoUrl && oldLogoUrl !== '/images/logo.png' && oldLogoUrl.startsWith('/uploads/')) {
        try {
          const oldLogoPath = path.join(__dirname, '../../uploads', path.basename(oldLogoUrl));
          await fs.access(oldLogoPath); // Check if file exists
          await fs.unlink(oldLogoPath); // Delete old logo
          console.log('Old logo deleted:', oldLogoPath);
        } catch (err) {
          console.log('Could not delete old logo:', err.message);
          // Don't fail the request if old logo deletion fails
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Logo uploaded successfully',
        data: {
          logoUrl,
          settings: updatedSettings
        }
      });
    } catch (error) {
      console.error('Upload logo error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload logo',
        error: error.message
      });
    }
  },

  // POST /settings/footer-logo - Upload footer logo
  uploadFooterLogo: async (req, res) => {
    try {
      const logoFile = req.files?.footerLogo?.[0];

      if (!logoFile) {
        return res.status(400).json({
          success: false,
          message: 'Footer logo file is required'
        });
      }

      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(logoFile.mimetype)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid file type. Please upload PNG, JPG, GIF, or WebP images only.'
        });
      }

      if (logoFile.size > 5 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          message: 'File size too large. Maximum size allowed is 5MB.'
        });
      }

      let footerLogoUrl;
      if (USE_BLOB_STORAGE && blobUpload) {
        footerLogoUrl = await blobUpload.uploadToBlob(
          logoFile.buffer, logoFile.originalname, logoFile.mimetype, 'settings'
        );
      } else {
        footerLogoUrl = `/uploads/${logoFile.filename}`;
      }

      const currentSettings = await Settings.getSettings();
      const oldFooterLogoUrl = currentSettings.footerLogoUrl;

      const updatedSettings = await Settings.updateSettings({ footerLogoUrl });

      if (oldFooterLogoUrl && oldFooterLogoUrl.startsWith('/uploads/')) {
        try {
          const oldLogoPath = path.join(__dirname, '../../uploads', path.basename(oldFooterLogoUrl));
          await fs.access(oldLogoPath);
          await fs.unlink(oldLogoPath);
        } catch (err) {
          console.log('Could not delete old footer logo:', err.message);
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Footer logo uploaded successfully',
        data: {
          footerLogoUrl,
          settings: updatedSettings
        }
      });
    } catch (error) {
      console.error('Upload footer logo error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload footer logo',
        error: error.message
      });
    }
  },

  // DELETE /settings/footer-logo - Remove footer logo
  removeFooterLogo: async (req, res) => {
    try {
      const currentSettings = await Settings.getSettings();
      const currentFooterLogoUrl = currentSettings.footerLogoUrl;

      const updatedSettings = await Settings.updateSettings({ footerLogoUrl: '' });

      if (currentFooterLogoUrl && currentFooterLogoUrl.startsWith('/uploads/')) {
        try {
          const logoPath = path.join(__dirname, '../../uploads', path.basename(currentFooterLogoUrl));
          await fs.access(logoPath);
          await fs.unlink(logoPath);
        } catch (err) {
          console.log('Could not delete footer logo file:', err.message);
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Footer logo removed successfully',
        data: updatedSettings
      });
    } catch (error) {
      console.error('Remove footer logo error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to remove footer logo',
        error: error.message
      });
    }
  },

  // DELETE /settings/logo - Remove logo (reset to default)
  removeLogo: async (req, res) => {
    try {
      // Get current settings
      const currentSettings = await Settings.getSettings();
      const currentLogoUrl = currentSettings.logoUrl;

      // Reset to default logo
      const defaultLogoUrl = '/images/logo.png';
      const updatedSettings = await Settings.updateSettings({ logoUrl: defaultLogoUrl });

      // Remove current logo file if it's uploaded (not default)
      if (currentLogoUrl && currentLogoUrl !== defaultLogoUrl && currentLogoUrl.startsWith('/uploads/')) {
        try {
          const logoPath = path.join(__dirname, '../../uploads', path.basename(currentLogoUrl));
          await fs.access(logoPath); // Check if file exists
          await fs.unlink(logoPath); // Delete logo
          console.log('Logo file deleted:', logoPath);
        } catch (err) {
          console.log('Could not delete logo file:', err.message);
          // Don't fail the request if logo deletion fails
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Logo reset to default successfully',
        data: updatedSettings
      });
    } catch (error) {
      console.error('Remove logo error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to remove logo',
        error: error.message
      });
    }
  },

  // POST /settings/reset - Reset all settings to default
  resetSettings: async (req, res) => {
    try {
      // Get current settings to backup logo
      const currentSettings = await Settings.getSettings();
      const currentLogoUrl = currentSettings.logoUrl;

      // Create default settings
      const defaultSettings = {
        siteName: 'The Jymor',
        siteUrl: 'https://www.inkedwearpk.com',
        logoUrl: '/images/logo.png',
        timezone: 'UTC+05:00',
        dateFormat: 'MM/DD/YYYY',
        emailNotifications: true,
        marketingEmails: false,
        securityAlerts: true,
        twoFactorAuth: false,
        currency: 'USD',
        taxRate: 0,
        paymentMethods: ['credit_card', 'paypal'],
        topSliderText: '',
        youtubeUrl: '',
        facebookUrl: '',
        instagramUrl: '',
        twitterUrl: '',
        tiktokUrl: ''
      };

      // Update settings to default
      const resetSettings = await Settings.updateSettings(defaultSettings);

      // Remove uploaded logo if exists
      if (currentLogoUrl && currentLogoUrl !== '/images/logo.png' && currentLogoUrl.startsWith('/uploads/')) {
        try {
          const logoPath = path.join(__dirname, '../../uploads', path.basename(currentLogoUrl));
          await fs.access(logoPath);
          await fs.unlink(logoPath);
          console.log('Uploaded logo deleted during reset:', logoPath);
        } catch (err) {
          console.log('Could not delete uploaded logo during reset:', err.message);
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Settings reset to default successfully',
        data: resetSettings
      });
    } catch (error) {
      console.error('Reset settings error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to reset settings',
        error: error.message
      });
    }
  }
};

module.exports = settingsController;