// src/models/homeSectionModel.js
//
// One document per homepage section (everything below the hero banner).
// The admin panel edits `content`, toggles `enabled` and drags `order`;
// the public homepage renders whatever this collection says.

const mongoose = require('mongoose');

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

// Default copy — matches what the homepage shipped with, so a fresh database
// renders the same site the static version did. Headings support `*word*`
// markers, which the frontend renders in the accent colour.
const DEFAULT_SECTIONS = [
  {
    key: 'about',
    order: 1,
    content: {
      badge: 'About Us',
      heading: 'The best fitness gym in town',
      description:
        'A full strength and conditioning floor, a dedicated studio for group classes, and coaches who actually watch your form. Whether you are lifting for the first time or chasing a personal best, you get a plan built around your goal, not a generic programme handed to everyone who walks in.',
      bullets: [
        'Open 7 days, with 24/7 access for members',
        'Certified coaches on the floor at all times',
        'Programmes tracked and reviewed every month',
      ],
      ctaText: "Let's Start",
      ctaLink: '/packages',
      image: '/images/gym-couple.png',
      secondHeading: 'Strength that shows',
      secondDescription:
        'Strength work is the fastest route to a body that performs as well as it looks. Our coaches build progressive lifting blocks around squat, hinge, push and pull, then track your numbers week to week so the progress is something you can see rather than something you hope for.',
      progress: [
        { label: 'Strength & Conditioning', value: 85 },
        { label: 'Muscle Tone', value: 90 },
      ],
    },
  },
  {
    key: 'stats',
    order: 2,
    content: {
      items: [
        { value: '1200', suffix: '+', label: 'Active members' },
        { value: '15', suffix: '+', label: 'Certified coaches' },
        { value: '40', suffix: '+', label: 'Classes every week' },
        { value: '10', suffix: 'yrs', label: 'Coaching experience' },
      ],
    },
  },
  {
    key: 'classes',
    order: 3,
    content: {
      badge: 'Classes',
      heading: 'What we do in our classes',
      description:
        'Classes run from sunrise to late evening and are capped so nobody trains unwatched. Strength, conditioning, mobility and recovery sessions, each with a scaled option so beginners and regulars can share the same floor.',
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
      description:
        'Walk the gym before you ever set foot in it — classes mid-session, coaching on the floor and the community that keeps people coming back.',
      videos: [],
    },
  },
  {
    key: 'trainers',
    order: 6,
    content: {
      badge: 'Our Trainers',
      heading: 'Coaches who train you like an athlete',
      description:
        'Every coach on the floor is certified, insured and has come up through the same programmes they now teach. Book an intro session and you will be paired with the one whose speciality matches what you are training for.',
      limit: 4,
    },
  },
  {
    key: 'testimonials',
    order: 7,
    content: {
      badge: 'Testimonials',
      heading: 'What our members say',
      description:
        'Real progress, told by the people who made it. Every review below comes from a member training on this floor right now.',
    },
  },
  {
    key: 'contact',
    order: 8,
    content: {
      badge: 'Contact Form',
      heading: 'Believe in yourself be *fit* & *healthier*',
      description:
        'Tell us what you are training for and we will point you at the right membership, class or coach. No hard sell, and no obligation to sign up on the spot.',
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

/**
 * Guarantees every known section exists, seeding defaults for any that are
 * missing. Never touches documents that already exist, so admin edits and
 * ordering survive both restarts and new deploys that add section types.
 */
homeSectionSchema.statics.ensureDefaults = async function () {
  const ops = DEFAULT_SECTIONS.map((section) => ({
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
};

homeSectionSchema.statics.SECTION_KEYS = SECTION_KEYS;
homeSectionSchema.statics.DEFAULT_SECTIONS = DEFAULT_SECTIONS;

module.exports = mongoose.model('HomeSection', homeSectionSchema);
