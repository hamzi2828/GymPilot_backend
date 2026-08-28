// src/controller/productController.js
const Product = require('../models/product');
const { toPublicPath } = require('../helper/upload');
const { processColorMedia } = require('../helper/colorMediaHelper');



const productController = {
  // GET /products - list all products
  listProducts: async (req, res) => {
    try {
      const products = await Product.find().sort({ createdAt: -1 });
      return res.status(200).json({ message: 'Products fetched successfully', data: products });
    } catch (error) {
      console.error('List products error:', error);
      return res.status(400).json({ message: 'Error fetching products', error: error.message });
    }
  },

  // GET /products/random - get random products for collection
  getRandomProducts: async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      
      // Get all published products with stock > 0
      const products = await Product.find({
        status: 'published',
        displayOn: { $ne: 'pos' },
        stock: { $gt: 0 }
      });
      
      // Shuffle the array and limit the results
      const shuffled = products.sort(() => Math.random() - 0.5).slice(0, limit);
      
      return res.status(200).json({ 
        message: 'Random products fetched successfully', 
        data: shuffled 
      });
    } catch (error) {
      console.error('Get random products error:', error);
      return res.status(400).json({ 
        message: 'Error fetching random products', 
        error: error.message 
      });
    }
  },

  // GET /products/latest - get latest products (public route)
  getLatestProducts: async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      
      // Get latest published products sorted by creation date
      const products = await Product.find({
        status: 'published',
        displayOn: { $ne: 'pos' }
      })
      .sort({ createdAt: -1 })
      .limit(limit);
      
      return res.status(200).json({ 
        message: 'Latest products fetched successfully', 
        data: products 
      });
    } catch (error) {
      console.error('Get latest products error:', error);
      return res.status(400).json({ 
        message: 'Error fetching latest products', 
        error: error.message 
      });
    }
  },

  // GET /products/:id - get product by id
  getProductById: async (req, res) => {
    try {
      const { id } = req.params;
      const product = await Product.findById(id);
      if (!product) return res.status(404).json({ message: 'Product not found' });
      return res.status(200).json({ message: 'Product fetched successfully', data: product });
    } catch (error) {
      console.error('Get product error:', error);
      return res.status(400).json({ message: 'Error fetching product', error: error.message });
    }
  },

  // POST /products - create a new product
  createProduct: async (req, res) => {
    try {
      const payload = req.body || {};
      const files = req.files || {};

      console.log('createProduct files:', files);
      console.log('createProduct body:', payload);
      
      // Use the createProductService to handle the creation logic
      const createProductService = require('../services/products/createProductService');
      const created = await createProductService.createProduct(payload, files);
      
      return res.status(201).json({ 
        message: 'Product created successfully', 
        data: created 
      });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Create product error:', error);
      return res.status(400).json({ message: 'Error creating product', error: error.message });
    }
  },

  // PUT /products/:id - update a product
  updateProduct: async (req, res) => {
    try {
      const { id } = req.params;
      const payload = req.body || {};
      const files = req.files || {};
      
      console.log('Update product payload:', payload);
      console.log('Update product files:', files);
      // Use the updateProductService to handle the update logic
      const updateProductService = require('../services/products/updateProductService');
      const updated = await updateProductService.updateProduct(id, payload, files);
      
      return res.status(200).json({ 
        message: 'Product updated successfully', 
        data: updated 
      });
      
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(409).json({ message: 'Slug already exists' });
      }
      console.error('Update product error:', error);
      return res.status(400).json({ 
        message: 'Error updating product', 
        error: error.message 
      });
    }
  },

  // DELETE /products/:id - delete a product
  deleteProduct: async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await Product.findByIdAndDelete(id);
      if (!deleted) return res.status(404).json({ message: 'Product not found' });
      return res.status(200).json({ message: 'Product deleted successfully', id });
    } catch (error) {
      console.error('Delete product error:', error);
      return res.status(400).json({ message: 'Error deleting product', error: error.message });
    }
  },
};

module.exports = productController;
