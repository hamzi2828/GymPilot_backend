// src/seeds/seedMeasurements.js

const mongoose = require('mongoose');
const Measurement = require('../models/measurement');

const defaultMeasurements = [
  {
    name: 'Chest',
    slug: 'chest',
    unit: 'inches',
    placeholder: 'e.g., 40',
    description: 'Measure around the fullest part of your chest',
    isRequired: true,
    sortOrder: 1,
  },
  {
    name: 'Waist',
    slug: 'waist',
    unit: 'inches',
    placeholder: 'e.g., 34',
    description: 'Measure around your natural waistline',
    isRequired: true,
    sortOrder: 2,
  },
  {
    name: 'Hips',
    slug: 'hips',
    unit: 'inches',
    placeholder: 'e.g., 42',
    description: 'Measure around the fullest part of your hips',
    isRequired: false,
    sortOrder: 3,
  },
  {
    name: 'Length',
    slug: 'length',
    unit: 'inches',
    placeholder: 'e.g., 28',
    description: 'Measure from shoulder to desired length',
    isRequired: true,
    sortOrder: 4,
  },
  {
    name: 'Sleeve',
    slug: 'sleeve',
    unit: 'inches',
    placeholder: 'e.g., 24',
    description: 'Measure from shoulder to wrist',
    isRequired: false,
    sortOrder: 5,
  },
  {
    name: 'Shoulder',
    slug: 'shoulder',
    unit: 'inches',
    placeholder: 'e.g., 18',
    description: 'Measure from one shoulder edge to the other',
    isRequired: false,
    sortOrder: 6,
  },
  {
    name: 'Neck',
    slug: 'neck',
    unit: 'inches',
    placeholder: 'e.g., 16',
    description: 'Measure around the base of your neck',
    isRequired: false,
    sortOrder: 7,
  },
  {
    name: 'Inseam',
    slug: 'inseam',
    unit: 'inches',
    placeholder: 'e.g., 32',
    description: 'Measure from crotch to ankle',
    isRequired: false,
    sortOrder: 8,
  },
  {
    name: 'Thigh',
    slug: 'thigh',
    unit: 'inches',
    placeholder: 'e.g., 24',
    description: 'Measure around the fullest part of your thigh',
    isRequired: false,
    sortOrder: 9,
  },
  {
    name: 'Bust',
    slug: 'bust',
    unit: 'inches',
    placeholder: 'e.g., 36',
    description: 'Measure around the fullest part of your bust',
    isRequired: false,
    sortOrder: 10,
  },
];

async function seedMeasurements() {
  try {
    console.log('Seeding measurements...');

    for (const measurement of defaultMeasurements) {
      const existing = await Measurement.findOne({ slug: measurement.slug });
      if (!existing) {
        await Measurement.create(measurement);
        console.log(`Created measurement: ${measurement.name}`);
      } else {
        console.log(`Measurement already exists: ${measurement.name}`);
      }
    }

    console.log('Measurements seeding completed!');
  } catch (error) {
    console.error('Error seeding measurements:', error);
    throw error;
  }
}

module.exports = { seedMeasurements, defaultMeasurements };

// If run directly
if (require.main === module) {
  const connectDB = require('../config/mongo');

  connectDB()
    .then(() => seedMeasurements())
    .then(() => {
      console.log('Done!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed:', err);
      process.exit(1);
    });
}
