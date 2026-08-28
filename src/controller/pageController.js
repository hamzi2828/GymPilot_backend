// src/controller/pageController.js
const Page = require('../models/pageModel');

// Get all pages (Admin)
const getAllPages = async (req, res) => {
  try {
    const pages = await Page.find().sort({ updatedAt: -1 });
    res.status(200).json({
      success: true,
      pages
    });
  } catch (error) {
    console.error('Error fetching pages:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pages',
      error: error.message
    });
  }
};

// Get page by slug (Public)
const getPageBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const page = await Page.findOne({ slug, status: 'published' });

    if (!page) {
      return res.status(404).json({
        success: false,
        message: 'Page not found'
      });
    }

    res.status(200).json({
      success: true,
      page
    });
  } catch (error) {
    console.error('Error fetching page:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch page',
      error: error.message
    });
  }
};

// Get page by ID (Admin)
const getPageById = async (req, res) => {
  try {
    const { id } = req.params;
    const page = await Page.findById(id);

    if (!page) {
      return res.status(404).json({
        success: false,
        message: 'Page not found'
      });
    }

    res.status(200).json({
      success: true,
      page
    });
  } catch (error) {
    console.error('Error fetching page:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch page',
      error: error.message
    });
  }
};

// Create page (Admin)
const createPage = async (req, res) => {
  try {
    const { title, slug, content, status, metaTitle, metaDescription, metaKeywords } = req.body;

    // Check if page with this slug already exists
    const existingPage = await Page.findOne({ slug });
    if (existingPage) {
      return res.status(400).json({
        success: false,
        message: 'A page with this slug already exists'
      });
    }

    const page = new Page({
      title,
      slug,
      content,
      status: status || 'draft',
      metaTitle,
      metaDescription,
      metaKeywords
    });

    await page.save();

    res.status(201).json({
      success: true,
      message: 'Page created successfully',
      page
    });
  } catch (error) {
    console.error('Error creating page:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create page',
      error: error.message
    });
  }
};

// Update page (Admin)
const updatePage = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, status, metaTitle, metaDescription, metaKeywords } = req.body;

    const page = await Page.findById(id);
    if (!page) {
      return res.status(404).json({
        success: false,
        message: 'Page not found'
      });
    }

    // Update fields
    if (title) page.title = title;
    if (content) page.content = content;
    if (status) page.status = status;
    if (metaTitle !== undefined) page.metaTitle = metaTitle;
    if (metaDescription !== undefined) page.metaDescription = metaDescription;
    if (metaKeywords !== undefined) page.metaKeywords = metaKeywords;

    await page.save();

    res.status(200).json({
      success: true,
      message: 'Page updated successfully',
      page
    });
  } catch (error) {
    console.error('Error updating page:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update page',
      error: error.message
    });
  }
};

// Toggle page status (Admin)
const togglePageStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const page = await Page.findById(id);
    if (!page) {
      return res.status(404).json({
        success: false,
        message: 'Page not found'
      });
    }

    page.status = status;
    await page.save();

    res.status(200).json({
      success: true,
      message: `Page ${status === 'published' ? 'published' : 'saved as draft'} successfully`,
      page
    });
  } catch (error) {
    console.error('Error toggling page status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle page status',
      error: error.message
    });
  }
};

// Delete page (Admin)
const deletePage = async (req, res) => {
  try {
    const { id } = req.params;

    const page = await Page.findByIdAndDelete(id);
    if (!page) {
      return res.status(404).json({
        success: false,
        message: 'Page not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Page deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting page:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete page',
      error: error.message
    });
  }
};

module.exports = {
  getAllPages,
  getPageBySlug,
  getPageById,
  createPage,
  updatePage,
  togglePageStatus,
  deletePage
};
