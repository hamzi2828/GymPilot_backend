/**
 * Seeds the gym-facing content the storefront renders: hero slides, trainers,
 * classes, packages and blogs (plus the blog category/author they reference).
 *
 * Images are absolute Unsplash URLs on purpose. The frontend's trainer/class
 * services prefix any relative path with NEXT_PUBLIC_BACKEND_URL, and the API
 * only serves /uploads — so a relative /images/... path would 404. Absolute
 * URLs pass through untouched and images.unsplash.com is already allowed in
 * next.config.ts remotePatterns.
 *
 * Idempotent: re-running replaces the seeded documents rather than duplicating.
 *
 * Usage: node Seeder/seedGymContent.js [--reset]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { enterContext, resolveGymContextFromArgs } = require('../scripts/lib/tenantScript');

const HeroSlide = require('../src/models/heroSlideModel');
const Trainer = require('../src/gymfolio/models/trainerModel');
const GymClass = require('../src/gymfolio/models/gymClassModel');
const Package = require('../src/gymfolio/models/packageModel');
const Blog = require('../src/models/blogModel');
const BlogCategory = require('../src/models/BlogCategory');
const Author = require('../src/models/authorModel');

const U = (id, w = 1600) =>
  `https://images.unsplash.com/${id}?ixlib=rb-4.0.3&auto=format&fit=crop&w=${w}&q=80`;

// Verified-loading photo ids already used elsewhere in this app.
const IMG = {
  lifting: 'photo-1571019613454-1cb2f99b2d8b',
  barbell: 'photo-1534438327276-14e5300c3a48',
  stretch: 'photo-1574680096145-d05b474e2155',
  kettle: 'photo-1583454110551-21f2fa2afe61',
  dumbbell: 'photo-1544367567-0f2fcb009e0b',
  studio: 'photo-1581009146145-b5ef050c2e1e',
};

const slug = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');

const heroSlides = [
  {
    title: 'Train Hard. Feel Unstoppable.',
    description:
      'State-of-the-art equipment, expert coaching and a community that shows up. Your first session is on us.',
    imageUrl: U(IMG.lifting),
    buttonText: 'View Packages',
    buttonLink: '/packages',
    secondButtonText: 'Browse Classes',
    secondButtonLink: '/classes',
    isActive: true,
    order: 1,
    ariaLabel: 'Athlete lifting weights in the gym',
  },
  {
    title: 'Coaching Built Around You',
    description:
      'Work one-to-one with certified trainers who tailor every session to your goals, your pace and your schedule.',
    imageUrl: U(IMG.barbell),
    buttonText: 'Meet the Trainers',
    buttonLink: '/trainers',
    secondButtonText: 'Get in Touch',
    secondButtonLink: '/contact-us',
    isActive: true,
    order: 2,
    ariaLabel: 'Trainer coaching a client through a barbell lift',
  },
  {
    title: 'Every Class. Every Level.',
    description:
      'From sunrise yoga to high-intensity conditioning — over forty sessions a week, all included in one membership.',
    imageUrl: U(IMG.studio),
    buttonText: 'See the Timetable',
    buttonLink: '/classes',
    secondButtonText: 'Join Today',
    secondButtonLink: '/packages',
    isActive: true,
    order: 3,
    ariaLabel: 'Group fitness class in a studio',
  },
];

const trainers = [
  {
    name: 'Marcus Ellery',
    role: 'Head Strength Coach',
    bio: 'Fifteen years turning nervous beginners into confident lifters. Marcus specialises in barbell mechanics and rebuilding strength after injury.',
    image: U(IMG.barbell, 800),
    specialties: ['Powerlifting', 'Olympic Lifting', 'Injury Rehab'],
    certifications: ['NSCA-CSCS', 'FRCms'],
    experience: 15,
    rating: 4.9,
    totalClasses: 320,
    isFeatured: true,
    order: 1,
  },
  {
    name: 'Priya Raman',
    role: 'Mobility & Yoga Lead',
    bio: 'Priya blends vinyasa flow with clinical mobility work, so you leave moving better than when you walked in.',
    image: U(IMG.stretch, 800),
    specialties: ['Vinyasa Yoga', 'Mobility', 'Breathwork'],
    certifications: ['RYT-500', 'FRC Mobility Specialist'],
    experience: 9,
    rating: 4.95,
    totalClasses: 410,
    isFeatured: true,
    order: 2,
  },
  {
    name: 'Danny Okafor',
    role: 'Conditioning Coach',
    bio: 'Ex-sprinter turned conditioning coach. Danny builds engines — expect intervals that are brutal, brief and genuinely fun.',
    image: U(IMG.lifting, 800),
    specialties: ['HIIT', 'Sprint Mechanics', 'Metabolic Conditioning'],
    certifications: ['UKSCA ASCC', 'Level 3 PT'],
    experience: 11,
    rating: 4.8,
    totalClasses: 275,
    isFeatured: true,
    order: 3,
  },
  {
    name: 'Sofia Marchetti',
    role: 'Boxing Coach',
    bio: 'Former national amateur champion. Sofia teaches footwork first, power second — technique that holds up when you are tired.',
    image: U(IMG.kettle, 800),
    specialties: ['Boxing', 'Pad Work', 'Footwork'],
    certifications: ['England Boxing Level 2'],
    experience: 8,
    rating: 4.85,
    totalClasses: 190,
    isFeatured: false,
    order: 4,
  },
  {
    name: 'Tom Whitfield',
    role: 'Personal Trainer',
    bio: 'Tom works with members returning to training after long breaks, building programmes that fit around shift work and family life.',
    image: U(IMG.dumbbell, 800),
    specialties: ['Fat Loss', 'Habit Coaching', 'Beginner Programming'],
    certifications: ['Level 3 PT', 'Precision Nutrition L1'],
    experience: 6,
    rating: 4.7,
    totalClasses: 150,
    isFeatured: false,
    order: 5,
  },
  {
    name: 'Amara Diallo',
    role: 'Dance & Movement Coach',
    bio: 'Amara runs the studio sessions people book out fastest. High energy, zero judgement, choreography you can actually follow.',
    image: U(IMG.studio, 800),
    specialties: ['Dance Fitness', 'Choreography', 'Group Training'],
    certifications: ['Level 3 Group Exercise'],
    experience: 7,
    rating: 4.9,
    totalClasses: 360,
    isFeatured: false,
    order: 6,
  },
];

const classes = [
  {
    name: 'Barbell Foundations',
    shortDescription: 'Learn the five main lifts properly, with hands-on coaching.',
    description:
      'A small-group session capped at twelve people, covering the squat, bench, deadlift, press and row. You will be coached through each lift with real feedback, not just counted through sets.',
    category: 'Strength',
    difficulty: 'Beginner',
    duration: 60,
    capacity: 12,
    price: 18,
    features: ['Max 12 people', 'Video form review', 'Take-home programme'],
    requirements: ['Trainers with a flat sole', 'Water bottle'],
    schedule: [
      { day: 'Monday', startTime: '18:00', endTime: '19:00', instructorName: 'Marcus Ellery' },
      { day: 'Thursday', startTime: '18:00', endTime: '19:00', instructorName: 'Marcus Ellery' },
    ],
    isFeatured: true,
    order: 1,
    rating: 4.9,
    reviewsCount: 84,
    enrolledCount: 11,
  },
  {
    name: 'Sunrise Vinyasa',
    shortDescription: 'A flowing 45-minute practice to start the day.',
    description:
      'Breath-led vinyasa that builds gently from grounding to a moderate peak, then unwinds. Suitable if you have never done yoga, and still worthwhile if you have done it for years.',
    category: 'Yoga',
    difficulty: 'All Levels',
    duration: 45,
    capacity: 20,
    price: 12,
    features: ['Mats provided', 'Heated studio', 'Beginner friendly'],
    requirements: ['Arrive five minutes early'],
    schedule: [
      { day: 'Tuesday', startTime: '06:45', endTime: '07:30', instructorName: 'Priya Raman' },
      { day: 'Saturday', startTime: '08:00', endTime: '08:45', instructorName: 'Priya Raman' },
    ],
    isFeatured: true,
    order: 2,
    rating: 4.95,
    reviewsCount: 132,
    enrolledCount: 17,
  },
  {
    name: 'Engine Room HIIT',
    shortDescription: 'Thirty minutes of intervals that build real work capacity.',
    description:
      'Rowers, bikes and sleds in short, hard intervals with strict rest. Scaled to your current fitness, so everyone finishes at the same time regardless of level.',
    category: 'HIIT',
    difficulty: 'Intermediate',
    duration: 30,
    capacity: 16,
    price: 14,
    features: ['Heart-rate tracking', 'Scaled to your level', 'Always 30 minutes'],
    requirements: ['Towel', 'Water bottle'],
    schedule: [
      { day: 'Monday', startTime: '07:00', endTime: '07:30', instructorName: 'Danny Okafor' },
      { day: 'Wednesday', startTime: '19:15', endTime: '19:45', instructorName: 'Danny Okafor' },
      { day: 'Friday', startTime: '07:00', endTime: '07:30', instructorName: 'Danny Okafor' },
    ],
    isFeatured: true,
    order: 3,
    rating: 4.8,
    reviewsCount: 96,
    enrolledCount: 15,
  },
  {
    name: 'Boxing Fundamentals',
    shortDescription: 'Stance, guard and footwork before you ever hit a bag.',
    description:
      'A technical boxing class that front-loads movement quality. Expect shadow work, pad rounds and conditioning finishers — no sparring, no contact.',
    category: 'Boxing',
    difficulty: 'Beginner',
    duration: 50,
    capacity: 14,
    price: 15,
    features: ['Gloves available to borrow', 'No contact', 'Pad work every session'],
    requirements: ['Hand wraps recommended'],
    schedule: [
      { day: 'Tuesday', startTime: '19:00', endTime: '19:50', instructorName: 'Sofia Marchetti' },
      { day: 'Saturday', startTime: '10:00', endTime: '10:50', instructorName: 'Sofia Marchetti' },
    ],
    isFeatured: false,
    order: 4,
    rating: 4.85,
    reviewsCount: 61,
    enrolledCount: 12,
  },
  {
    name: 'Mobility Reset',
    shortDescription: 'Undo a week at a desk in forty minutes.',
    description:
      'Joint-by-joint mobility work targeting hips, thoracic spine and shoulders. Low intensity, high value — the session members say they feel the most the next day.',
    category: 'Other',
    difficulty: 'All Levels',
    duration: 40,
    capacity: 18,
    price: 10,
    features: ['Mats and bands provided', 'Desk-worker focused', 'Low intensity'],
    requirements: [],
    schedule: [
      { day: 'Wednesday', startTime: '12:30', endTime: '13:10', instructorName: 'Priya Raman' },
      { day: 'Sunday', startTime: '09:30', endTime: '10:10', instructorName: 'Priya Raman' },
    ],
    isFeatured: false,
    order: 5,
    rating: 4.75,
    reviewsCount: 47,
    enrolledCount: 9,
  },
  {
    name: 'Studio Dance',
    shortDescription: 'Cardio that does not feel like cardio.',
    description:
      'Choreographed dance fitness set to a proper sound system. Routines repeat across the month so you get to actually nail them.',
    category: 'Dance',
    difficulty: 'All Levels',
    duration: 45,
    capacity: 25,
    price: 12,
    features: ['No experience needed', 'New routine monthly', 'Big sound system'],
    requirements: ['Trainers you can pivot in'],
    schedule: [
      { day: 'Thursday', startTime: '19:30', endTime: '20:15', instructorName: 'Amara Diallo' },
      { day: 'Sunday', startTime: '11:00', endTime: '11:45', instructorName: 'Amara Diallo' },
    ],
    isFeatured: false,
    order: 6,
    rating: 4.9,
    reviewsCount: 118,
    enrolledCount: 22,
  },
];

const packages = [
  {
    name: 'Off-Peak',
    price: 24,
    currency: 'GBP',
    period: 'month',
    theme: 'light',
    badge: '',
    supportingText: 'Full gym access weekdays before 4pm. Ideal if your schedule is flexible.',
    features: ['Gym floor access 6am–4pm', 'Two classes per month', 'Free induction session', 'No joining fee'],
    isActive: true,
    order: 1,
  },
  {
    name: 'Full Member',
    price: 39,
    currency: 'GBP',
    period: 'month',
    theme: 'dark',
    badge: 'Most Popular',
    supportingText: 'Everything, any time, with unlimited classes included.',
    features: ['24/7 gym floor access', 'Unlimited classes', 'Quarterly progress review', 'Guest pass each month', 'No joining fee'],
    isActive: true,
    order: 2,
  },
  {
    name: 'Performance',
    price: 79,
    currency: 'GBP',
    period: 'month',
    theme: 'light',
    badge: '',
    supportingText: 'For members training with a specific goal and a deadline.',
    features: ['Everything in Full Member', 'Two PT sessions monthly', 'Personalised programming', 'Nutrition consultation', 'Recovery suite access'],
    isActive: true,
    order: 3,
  },
];

async function run() {
  const reset = process.argv.includes('--reset');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set. See .env.example.');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to', mongoose.connection.name);
  // Every gym has its own database: --gym <slug> picks which one.
  enterContext(await resolveGymContextFromArgs());

  const report = [];

  // Hero slides
  await HeroSlide.deleteMany(reset ? {} : { title: { $in: heroSlides.map((s) => s.title) } });
  report.push(['hero slides', (await HeroSlide.insertMany(heroSlides)).length]);

  // Trainers
  const trainerDocs = trainers.map((t) => ({ ...t, slug: slug(t.name), isActive: true }));
  await Trainer.deleteMany(reset ? {} : { slug: { $in: trainerDocs.map((t) => t.slug) } });
  const savedTrainers = await Trainer.insertMany(trainerDocs);
  report.push(['trainers', savedTrainers.length]);

  const trainerBySlug = new Map(savedTrainers.map((t) => [t.name, t._id]));

  // Classes — link each schedule entry to the real trainer document
  const classDocs = classes.map((c, i) => ({
    ...c,
    slug: slug(c.name),
    isActive: true,
    thumbnail: U(Object.values(IMG)[i % 6], 900),
    videoPoster: U(Object.values(IMG)[i % 6], 1200),
    gallery: [],
    tags: [c.category.toLowerCase(), c.difficulty.toLowerCase()],
    currency: 'GBP',
    schedule: c.schedule.map((s) => ({
      ...s,
      instructor: trainerBySlug.get(s.instructorName),
    })),
  }));
  await GymClass.deleteMany(reset ? {} : { slug: { $in: classDocs.map((c) => c.slug) } });
  report.push(['classes', (await GymClass.insertMany(classDocs)).length]);

  // Packages
  await Package.deleteMany(reset ? {} : { name: { $in: packages.map((p) => p.name) } });
  report.push(['packages', (await Package.insertMany(packages)).length]);

  // Blog category + author, then blogs
  let category = await BlogCategory.findOne({ name: 'Training' });
  if (!category) category = await BlogCategory.create({ name: 'Training', slug: 'training' });

  let author = await Author.findOne({ name: 'The Coaching Team' });
  if (!author) {
    author = await Author.create({
      name: 'The Coaching Team',
      slug: 'the-coaching-team',
      email: 'coaches@yourgym.com',
      bio: 'Coaching staff writing about training, recovery and everything in between.',
      isActive: true,
    });
  }

  const blogs = [
    {
      title: 'How Many Sets Do You Actually Need?',
      excerpt: 'The honest answer to the most common question on the gym floor.',
      content:
        'Most people training for general strength do well on ten to twenty hard sets per muscle group per week. Below ten and progress is slow; above twenty and recovery usually becomes the limiting factor rather than effort. Start at the lower end, add a set per week, and back off when your performance stalls two sessions in a row.',
      image: U(IMG.barbell, 1200),
    },
    {
      title: 'Why Your Warm-Up Is Probably Too Long',
      excerpt: 'Ten focused minutes beats thirty unfocused ones.',
      content:
        'A warm-up has two jobs: raise tissue temperature and rehearse the movement you are about to load. Five minutes on a bike followed by three progressively heavier sets of your first lift does both. Foam rolling for twenty minutes does neither particularly well.',
      image: U(IMG.stretch, 1200),
    },
    {
      title: 'Training Around a Desk Job',
      excerpt: 'What to prioritise when you sit for eight hours a day.',
      content:
        'Sitting is not inherently harmful, but staying in one position for hours is. The fix is not a perfect chair, it is frequent position changes plus training that loads your hips and thoracic spine through a full range. Two mobility sessions a week alongside your normal lifting is usually enough.',
      image: U(IMG.studio, 1200),
    },
    {
      title: 'Protein: How Much, and Does Timing Matter?',
      excerpt: 'The short version, without the supplement-industry noise.',
      content:
        'Aim for roughly 1.6 grams of protein per kilogram of bodyweight per day if you are training regularly. Total daily intake matters far more than timing. The anabolic window is closer to several hours than thirty minutes, so eat when it suits your day rather than sprinting to a shaker.',
      image: U(IMG.dumbbell, 1200),
    },
  ];

  const blogDocs = blogs.map((b, i) => ({
    ...b,
    slug: slug(b.title),
    thumbnail: b.image,
    categoryId: category._id,
    author: author._id,
    status: 'published',
    featured: i < 2,
    views: 120 + i * 37,
    tags: ['training', 'guides'],
    metaTitle: b.title,
    metaDescription: b.excerpt,
  }));
  await Blog.deleteMany(reset ? {} : { slug: { $in: blogDocs.map((b) => b.slug) } });
  report.push(['blogs', (await Blog.insertMany(blogDocs)).length]);

  console.log('\nSeeded:');
  for (const [label, n] of report) console.log(`  ${label.padEnd(14)} ${n}`);

  await mongoose.disconnect();
}

run()
  .then(() => {
    console.log('\nDone.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Seed failed:', err.message);
    if (err.errors) {
      for (const [k, e] of Object.entries(err.errors)) console.error(`  ${k}: ${e.message}`);
    }
    process.exit(1);
  });
