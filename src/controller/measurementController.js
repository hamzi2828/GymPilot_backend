// src/controller/measurementController.js

const Measurement = require('../models/measurement');
const Category = require('../models/category');

// Helper to generate slug from name
const generateSlug = (name) => {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

// List all measurements
exports.listMeasurements = async (req, res) => {
  try {
    const { activeOnly } = req.query;
    const filter = activeOnly === 'true' ? { active: true } : {};
    const measurements = await Measurement.find(filter).sort({ sortOrder: 1, createdAt: -1 });
    res.json({ success: true, data: measurements });
  } catch (error) {
    console.error('Error listing measurements:', error);
    res.status(500).json({ success: false, message: 'Failed to list measurements' });
  }
};

// Get measurement by ID
exports.getMeasurementById = async (req, res) => {
  try {
    const measurement = await Measurement.findById(req.params.id);
    if (!measurement) {
      return res.status(404).json({ success: false, message: 'Measurement not found' });
    }
    res.json({ success: true, data: measurement });
  } catch (error) {
    console.error('Error getting measurement:', error);
    res.status(500).json({ success: false, message: 'Failed to get measurement' });
  }
};

// Create new measurement
exports.createMeasurement = async (req, res) => {
  try {
    const { name, unit, placeholder, description, isRequired, active, sortOrder } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }

    const slug = generateSlug(name);

    // Check for duplicate slug
    const existing = await Measurement.findOne({ slug });
    if (existing) {
      return res.status(400).json({ success: false, message: 'A measurement with this name already exists' });
    }

    const measurement = new Measurement({
      name: name.trim(),
      slug,
      unit: unit || 'inches',
      placeholder: placeholder || '',
      description: description || '',
      isRequired: isRequired || false,
      active: active !== false,
      sortOrder: sortOrder || 0,
    });

    await measurement.save();
    res.status(201).json({ success: true, data: measurement });
  } catch (error) {
    console.error('Error creating measurement:', error);
    res.status(500).json({ success: false, message: 'Failed to create measurement' });
  }
};

// Update measurement
exports.updateMeasurement = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, unit, placeholder, description, isRequired, active, sortOrder } = req.body;

    const measurement = await Measurement.findById(id);
    if (!measurement) {
      return res.status(404).json({ success: false, message: 'Measurement not found' });
    }

    // If name is changing, update slug and check for duplicates
    if (name && name.trim() !== measurement.name) {
      const newSlug = generateSlug(name);
      const existing = await Measurement.findOne({ slug: newSlug, _id: { $ne: id } });
      if (existing) {
        return res.status(400).json({ success: false, message: 'A measurement with this name already exists' });
      }
      measurement.name = name.trim();
      measurement.slug = newSlug;
    }

    if (unit !== undefined) measurement.unit = unit;
    if (placeholder !== undefined) measurement.placeholder = placeholder;
    if (description !== undefined) measurement.description = description;
    if (isRequired !== undefined) measurement.isRequired = isRequired;
    if (active !== undefined) measurement.active = active;
    if (sortOrder !== undefined) measurement.sortOrder = sortOrder;

    await measurement.save();
    res.json({ success: true, data: measurement });
  } catch (error) {
    console.error('Error updating measurement:', error);
    res.status(500).json({ success: false, message: 'Failed to update measurement' });
  }
};

// Delete measurement
exports.deleteMeasurement = async (req, res) => {
  try {
    const { id } = req.params;
    const measurement = await Measurement.findById(id);
    if (!measurement) {
      return res.status(404).json({ success: false, message: 'Measurement not found' });
    }

    // Remove this measurement from all categories
    await Category.updateMany(
      { measurements: id },
      { $pull: { measurements: id } }
    );

    await Measurement.findByIdAndDelete(id);
    res.json({ success: true, message: 'Measurement deleted successfully' });
  } catch (error) {
    console.error('Error deleting measurement:', error);
    res.status(500).json({ success: false, message: 'Failed to delete measurement' });
  }
};

// Toggle active status
exports.toggleActive = async (req, res) => {
  try {
    const { id } = req.params;
    const measurement = await Measurement.findById(id);
    if (!measurement) {
      return res.status(404).json({ success: false, message: 'Measurement not found' });
    }

    measurement.active = !measurement.active;
    await measurement.save();
    res.json({ success: true, data: measurement });
  } catch (error) {
    console.error('Error toggling measurement status:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle measurement status' });
  }
};

// Get measurements for a specific category
exports.getCategoryMeasurements = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const category = await Category.findById(categoryId).populate('measurements');
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    // Filter only active measurements
    const measurements = (category.measurements || []).filter(m => m.active);
    res.json({ success: true, data: measurements });
  } catch (error) {
    console.error('Error getting category measurements:', error);
    res.status(500).json({ success: false, message: 'Failed to get category measurements' });
  }
};

// Update measurements for a category
exports.updateCategoryMeasurements = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { measurementIds } = req.body;

    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    // Validate all measurement IDs exist
    if (measurementIds && measurementIds.length > 0) {
      const validMeasurements = await Measurement.find({ _id: { $in: measurementIds } });
      if (validMeasurements.length !== measurementIds.length) {
        return res.status(400).json({ success: false, message: 'Some measurements not found' });
      }
    }

    category.measurements = measurementIds || [];
    await category.save();

    // Return populated category
    const updatedCategory = await Category.findById(categoryId).populate('measurements');
    res.json({ success: true, data: updatedCategory });
  } catch (error) {
    console.error('Error updating category measurements:', error);
    res.status(500).json({ success: false, message: 'Failed to update category measurements' });
  }
};
