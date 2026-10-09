// src/models/homeSectionModel.js
//
// One document per homepage section (everything below the hero banner).
// The admin panel edits `content`, toggles `enabled` and drags `order`;
// the public homepage renders whatever this collection says.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');
const { tenantKey } = require('../platform/tenantContext');

// Every section the homepage knows how to render. Adding a new section type
// means: add its key here + a default below, teach the frontend to render it.
const SECTION_KEYS = [
  'about',
  'stats',
  'classes',
  'gallery',
  'videos',
  'trainers',
  'testimonials',
  'contact',
  'blogs',
];

// Default copy: what a new gym's website says until its owner writes their
// own. So it must be true of any gym -- no member counts, opening hours,
// facilities or claims about staff that this particular gym never made. A
// figure nobody has supplied is left out (the stats band ships switched off
// and empty, the about section has no progress bars) rather than invented.
// Headings support `*word*` markers, which the frontend renders in the
// accent colour.
const DEFAULT_SECTIONS = [
  {
    key: 'about',
    order: 1,
    content: {
      badge: 'About Us',
      heading: 'Welcome to our gym',
      description:
        'A place to train, whatever your starting point. Whether you are lifting for the first time or chasing a personal best, come in, look around and find what suits your goal.',
      bullets: [
        'For beginners and regulars alike',
        'Train at your own pace',
        'Membership options to suit you',
      ],
      ctaText: "Let's Start",
      ctaLink: '/packages',
      image: '/images/gym-couple.png',
      secondHeading: 'Train for the long run',
      secondDescription:
        'Regular training builds strength, stamina and confidence that carry into everyday life. Start where you are, keep showing up, and let the results build over time.',
      // Percentage bars ({ label, value }) the gym adds for itself.
      progress: [],
    },
  },
  {
    key: 'stats',
    order: 2,
    // Ships hidden with no figures: the band appears once the admin enters
    // the gym's own numbers in /admin/homepage and enables it.
    enabled: false,
    content: {
      items: [],
    },
  },
  {
    key: 'classes',
    order: 3,
    content: {
      badge: 'Classes',
      heading: 'What we do in our classes',
      description: 'Take a look at the classes on offer and pick the ones that fit your week.',
    },
  },
  {
    key: 'gallery',
    order: 4,
    content: {
      badge: 'Gallery',
      heading: 'Believe in yourself be *fit* & *healthier*',
      // Sub-sections the admin creates (Strength, Cardio, …). Each holds up to
      // 12 photos, rendered 4 per row / 2 rows per page with a slider beyond.
      groups: [
        {
          title: 'Strength',
          images: [
            {
              src: 'https://images.unsplash.com/photo-1574680096145-d05b474e2155?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80',
              alt: 'Strength workout session',
            },
            {
              src: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80',
              alt: 'Gym equipment and weights',
            },
            {
              src: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80',
              alt: 'Personal training session',
            },
            {
              src: 'https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80',
              alt: 'Barbell training',
            },
          ],
        },
        {
          title: 'Cardio',
          images: [
            {
              src: 'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80',
              alt: 'Cardio workout equipment',
            },
            {
              src: 'https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80',
              alt: 'Conditioning session',
            },
          ],
        },
      ],
    },
  },
  {
    key: 'videos',
    order: 5,
    // Ships hidden with no videos: the section appears once the admin adds
    // clips in /admin/homepage and enables it.
    enabled: false,
    content: {
      badge: 'Videos',
      heading: 'See the floor in *action*',
      description: 'Take a look around before your first visit.',
      videos: [],
    },
  },
  {
    key: 'trainers',
    order: 6,
    content: {
      badge: 'Our Trainers',
      heading: 'Meet our trainers',
      description: 'The people you will be training with.',
      limit: 4,
    },
  },
  {
    key: 'testimonials',
    order: 7,
    content: {
      badge: 'Testimonials',
      heading: 'What our members say',
      description: 'In the words of the people who train with us.',
    },
  },
  {
    key: 'contact',
    order: 8,
    content: {
      badge: 'Contact Form',
      heading: 'Believe in yourself be *fit* & *healthier*',
      description: 'Have a question, or want to come and see the gym? Send us a message and we will get back to you.',
      formTitle: 'Registration Form',
      buttonText: 'Contact Us',
    },
  },
  {
    key: 'blogs',
    order: 9,
    content: {
      badge: 'Fitness Tips',
      heading: 'Stay Fit Stay Strong',
    },
  },
];

const homeSectionSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      enum: SECTION_KEYS,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    order: {
      type: Number,
      default: 0,
    },
    // Section-specific fields (headings, copy, image URLs, lists). Kept
    // schemaless on purpose: each section type has its own shape and the
    // admin UI owns the field definitions.
    content: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    // Without this Mongoose strips empty objects from `content` on save.
    minimize: false,
  }
);

homeSectionSchema.index({ order: 1 });

// Which gyms this process has already checked. Once every section exists it
// cannot go missing again short of somebody deleting rows by hand, so the
// check is made once per gym per process rather than as nine upserts on
// every homepage read. Keyed by tenant like roleService's cache: one gym's
// answer must never stand in for another's.
const ensured = new Map(); // tenantKey -> true | Promise (in flight)

/**
 * Guarantees every known section exists, seeding defaults for any that are
 * missing. Never touches documents that already exist, so admin edits and
 * ordering survive both restarts and new deploys that add section types.
 */
homeSectionSchema.statics.ensureDefaults = async function () {
  const key = tenantKey();
  const state = ensured.get(key);
  if (state === true) return;
  // A second reader arriving mid-check waits for the first rather than
  // starting its own.
  if (state) return state;

  const run = (async () => {
    const present = new Set(await this.distinct('key', { key: { $in: SECTION_KEYS } }));
    const missing = DEFAULT_SECTIONS.filter((section) => !present.has(section.key));
    if (!missing.length) return;
    const ops = missing.map((section) => ({
      updateOne: {
        filter: { key: section.key },
        update: {
          $setOnInsert: {
            key: section.key,
            // Sections may ship disabled (e.g. videos, until clips are added).
            enabled: section.enabled !== false,
            order: section.order,
            content: section.content,
          },
        },
        upsert: true,
      },
    }));
    await this.bulkWrite(ops, { ordered: false });
  })();

  ensured.set(key, run);
  try {
    await run;
    ensured.set(key, true);
  } catch (error) {
    ensured.delete(key);
    throw error;
  }
};

/** Forgets the current gym's check, so the next read seeds again. */
homeSectionSchema.statics.resetDefaultsCache = function () {
  ensured.delete(tenantKey());
};

homeSectionSchema.statics.SECTION_KEYS = SECTION_KEYS;
homeSectionSchema.statics.DEFAULT_SECTIONS = DEFAULT_SECTIONS;

module.exports = tenantModel('HomeSection', homeSectionSchema);
