// createGymClasses.js - Create gym classes with comprehensive data

const mongoose = require('mongoose');
const { enterContext, resolveGymContextFromArgs } = require('../scripts/lib/tenantScript');
const GymClass = require('../src/models/gymClassModel');
const Trainer = require('../src/models/trainerModel');

// Database connection
async function connectDB() {
  require('dotenv').config();
  const MONGO_URI = process.env.MONGO_URI;

  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    console.log(`✅ Connected to MongoDB Database: ${mongoose.connection.name}`);
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

// Class data templates
const classTemplates = [
  {
    name: 'Power Yoga Flow',
    description: `<h2>Transform Your Body and Mind</h2>
    <p>Power Yoga Flow is a dynamic, athletic style of yoga that builds strength, flexibility, and mental clarity. This class combines traditional yoga poses with flowing movements and breath work to create a challenging yet accessible practice for all levels.</p>

    <h3>What to Expect</h3>
    <p>Each session begins with centering and breath work, moves through a series of sun salutations, standing poses, balances, and concludes with deep stretching and relaxation. The flowing nature of the class keeps your heart rate elevated while building lean muscle and improving flexibility.</p>

    <h3>Benefits</h3>
    <ul>
      <li><strong>Increased Strength:</strong> Build lean muscle through body-weight exercises</li>
      <li><strong>Enhanced Flexibility:</strong> Improve range of motion and reduce injury risk</li>
      <li><strong>Mental Clarity:</strong> Reduce stress and increase focus</li>
      <li><strong>Better Balance:</strong> Develop core stability and coordination</li>
      <li><strong>Cardiovascular Health:</strong> Improve heart health through flowing movements</li>
    </ul>

    <h3>Who Should Join</h3>
    <p>This class is perfect for those who want a challenging workout that combines strength, flexibility, and mindfulness. Whether you're new to yoga or an experienced practitioner, our instructor will offer modifications to suit your level.</p>

    <blockquote>
      <p><em>"Yoga is not about touching your toes. It's about what you learn on the way down." - Jigar Gor</em></p>
    </blockquote>`,
    shortDescription: 'Dynamic yoga class that builds strength, flexibility, and mental clarity through flowing movements and breath work.',
    thumbnail: '/uploads/class1.svg',
    gallery: ['/uploads/class1.svg'],
    duration: 60,
    difficulty: 'All Levels',
    capacity: 25,
    category: 'Yoga',
    features: [
      'Strength Building',
      'Flexibility Training',
      'Breath Work',
      'Meditation',
      'Core Strengthening',
      'Balance Training'
    ],
    requirements: [
      'Yoga mat (provided if needed)',
      'Comfortable athletic wear',
      'Water bottle',
      'Towel',
      'Open mind and positive attitude'
    ],
    tags: ['yoga', 'strength', 'flexibility', 'mindfulness', 'all-levels'],
    price: 1500,
    isActive: true,
    isFeatured: true,
    rating: 4.9,
    reviewsCount: 87,
    enrolledCount: 145,
    trainerEmail: 'emily.rodriguez@demogym.test',
    schedule: [
      { day: 'Monday', startTime: '07:00', endTime: '08:00' },
      { day: 'Wednesday', startTime: '07:00', endTime: '08:00' },
      { day: 'Friday', startTime: '07:00', endTime: '08:00' }
    ]
  },
  {
    name: 'HIIT Bootcamp',
    description: `<h2>Maximum Results in Minimum Time</h2>
    <p>HIIT Bootcamp is an intense, high-energy class designed to torch calories, build strength, and boost your metabolism. Using scientifically-proven high-intensity interval training methods, this class delivers maximum results in just 45 minutes.</p>

    <h3>Class Structure</h3>
    <p>Our bootcamp sessions combine bodyweight exercises, resistance training, and cardiovascular bursts in timed intervals. You'll work hard for 30-45 seconds, followed by brief recovery periods, keeping your heart rate in the optimal fat-burning zone.</p>

    <h3>What You'll Do</h3>
    <ul>
      <li>Explosive plyometric movements</li>
      <li>Strength circuits with weights</li>
      <li>Core-focused exercises</li>
      <li>Sprint intervals and cardio bursts</li>
      <li>Functional movement patterns</li>
    </ul>

    <h3>Benefits</h3>
    <ul>
      <li><strong>Burn Calories:</strong> Continue burning calories up to 48 hours post-workout</li>
      <li><strong>Build Lean Muscle:</strong> Develop functional strength and definition</li>
      <li><strong>Improve Endurance:</strong> Boost cardiovascular fitness rapidly</li>
      <li><strong>Time-Efficient:</strong> Get maximum results in minimal time</li>
      <li><strong>Metabolic Boost:</strong> Increase your resting metabolic rate</li>
    </ul>

    <h3>Intensity Level</h3>
    <p>This is a challenging class, but modifications are always offered. Push yourself at your own pace and gradually increase intensity as your fitness improves.</p>

    <p><strong>Important:</strong> Bring extra water and a towel - you'll need them!</p>`,
    shortDescription: 'High-intensity interval training that maximizes calorie burn, builds strength, and boosts metabolism in 45 minutes.',
    thumbnail: '/uploads/class2.svg',
    gallery: ['/uploads/class2.svg'],
    duration: 45,
    difficulty: 'Intermediate',
    capacity: 20,
    category: 'HIIT',
    features: [
      'High-Intensity Intervals',
      'Full Body Workout',
      'Calorie Torching',
      'Strength Building',
      'Cardio Conditioning',
      'Metabolic Boost'
    ],
    requirements: [
      'Athletic shoes with good support',
      'Comfortable workout clothes',
      'Water bottle (essential)',
      'Towel',
      'Basic fitness level recommended'
    ],
    tags: ['hiit', 'bootcamp', 'cardio', 'strength', 'fat-loss', 'intense'],
    price: 1800,
    isActive: true,
    isFeatured: true,
    rating: 4.8,
    reviewsCount: 112,
    enrolledCount: 198,
    trainerEmail: 'marcus.chen@demogym.test',
    schedule: [
      { day: 'Monday', startTime: '06:00', endTime: '06:45' },
      { day: 'Wednesday', startTime: '06:00', endTime: '06:45' },
      { day: 'Friday', startTime: '06:00', endTime: '06:45' },
      { day: 'Saturday', startTime: '09:00', endTime: '09:45' }
    ]
  },
  {
    name: 'CrossFit Fundamentals',
    description: `<h2>Master the Movements, Build Your Foundation</h2>
    <p>CrossFit Fundamentals is designed to teach you the essential movements and techniques used in functional fitness training. This class focuses on proper form, safety, and building a solid foundation for more advanced workouts.</p>

    <h3>What is CrossFit?</h3>
    <p>CrossFit is a strength and conditioning program that combines weightlifting, gymnastics, and metabolic conditioning. It develops broad, general, and inclusive fitness through constantly varied functional movements performed at high intensity.</p>

    <h3>Class Focus</h3>
    <p>In this fundamentals class, you'll learn:</p>
    <ul>
      <li><strong>Olympic Lifts:</strong> Snatch, clean, and jerk variations</li>
      <li><strong>Powerlifting:</strong> Squat, deadlift, and press movements</li>
      <li><strong>Gymnastics:</strong> Pull-ups, muscle-ups, handstands</li>
      <li><strong>Metabolic Conditioning:</strong> Running, rowing, jumping rope</li>
      <li><strong>Core Work:</strong> Stability and strength exercises</li>
    </ul>

    <h3>Training Methodology</h3>
    <p>Each class includes a warm-up, skill development, strength work, and a workout of the day (WOD). We scale all workouts to your current fitness level, ensuring you're challenged but not overwhelmed.</p>

    <h3>Benefits</h3>
    <ul>
      <li>Comprehensive full-body fitness</li>
      <li>Increased work capacity across all domains</li>
      <li>Community and camaraderie</li>
      <li>Constantly varied programming prevents plateaus</li>
      <li>Measurable, trackable results</li>
    </ul>

    <h3>Nutrition Guidance</h3>
    <p>As part of this class, you'll receive basic nutrition coaching to optimize your performance and recovery. Our coach will help you understand how to fuel your body for optimal results.</p>

    <p><strong>Note:</strong> No prior CrossFit experience required. All movements are scalable to your level.</p>`,
    shortDescription: 'Learn essential CrossFit movements and build functional fitness through weightlifting, gymnastics, and metabolic conditioning.',
    thumbnail: '/uploads/class3.svg',
    gallery: ['/uploads/class3.svg'],
    duration: 60,
    difficulty: 'Intermediate',
    capacity: 15,
    category: 'Strength',
    features: [
      'Olympic Weightlifting',
      'Functional Fitness',
      'Gymnastics Movements',
      'Metabolic Conditioning',
      'Nutrition Coaching',
      'Scalable Workouts'
    ],
    requirements: [
      'Athletic shoes',
      'Comfortable athletic wear',
      'Water bottle',
      'Wrist wraps (optional)',
      'Knee sleeves (optional)',
      'Basic fitness level'
    ],
    tags: ['crossfit', 'functional-fitness', 'strength', 'conditioning', 'olympic-lifting'],
    price: 2000,
    isActive: true,
    isFeatured: true,
    rating: 4.9,
    reviewsCount: 95,
    enrolledCount: 167,
    trainerEmail: 'david.thompson@demogym.test',
    schedule: [
      { day: 'Tuesday', startTime: '18:00', endTime: '19:00' },
      { day: 'Thursday', startTime: '18:00', endTime: '19:00' },
      { day: 'Saturday', startTime: '10:00', endTime: '11:00' }
    ]
  },
  {
    name: 'Dance Fitness Party',
    description: `<h2>Dance Your Way to Fitness</h2>
    <p>Dance Fitness Party is the ultimate fun workout that doesn't feel like work! This high-energy class combines dance moves from various styles including Latin, hip-hop, and contemporary to create a full-body cardio workout that burns calories while you have a blast.</p>

    <h3>What Makes It Special</h3>
    <p>Forget boring treadmill sessions! This class brings the energy of a dance party to your workout. With upbeat music, easy-to-follow choreography, and a supportive atmosphere, you'll be smiling while you sweat.</p>

    <h3>Dance Styles Included</h3>
    <ul>
      <li><strong>Latin Dance:</strong> Salsa, merengue, reggaeton, cumbia</li>
      <li><strong>Hip-Hop:</strong> Urban choreography and street dance</li>
      <li><strong>Bollywood:</strong> Energetic Indian dance fusion</li>
      <li><strong>Pop Hits:</strong> Current chart-topping tracks</li>
      <li><strong>Retro Classics:</strong> Throwback jams that everyone loves</li>
    </ul>

    <h3>Health Benefits</h3>
    <ul>
      <li><strong>Cardio Workout:</strong> Burn 400-600 calories per session</li>
      <li><strong>Coordination:</strong> Improve balance and body awareness</li>
      <li><strong>Stress Relief:</strong> Dance away tension and boost mood</li>
      <li><strong>Social Connection:</strong> Meet new friends in a fun environment</li>
      <li><strong>Confidence Building:</strong> Feel empowered and energized</li>
    </ul>

    <h3>No Dance Experience Needed!</h3>
    <p>Our instructor breaks down each move step-by-step. The focus is on having fun and moving your body, not on perfection. Everyone is welcome regardless of dance experience or fitness level.</p>

    <h3>What to Expect</h3>
    <p>Each class includes a warm-up with basic steps, multiple dance songs with different styles, and a cool-down with stretching. The choreography is easy to follow and designed to keep you moving for the full 50 minutes.</p>

    <blockquote>
      <p><em>"Dance is the hidden language of the soul." - Martha Graham</em></p>
    </blockquote>

    <p><strong>Pro Tip:</strong> Wear comfortable clothes you can move in and bring your best dance spirit!</p>`,
    shortDescription: 'High-energy dance workout combining Latin, hip-hop, and contemporary styles for a fun full-body cardio experience.',
    thumbnail: '/uploads/class4.svg',
    gallery: ['/uploads/class4.svg'],
    duration: 50,
    difficulty: 'Beginner',
    capacity: 30,
    category: 'Dance',
    features: [
      'Easy-to-Follow Choreography',
      'Multiple Dance Styles',
      'High-Calorie Burn',
      'Upbeat Music',
      'All Fitness Levels Welcome',
      'Social Atmosphere'
    ],
    requirements: [
      'Comfortable athletic wear',
      'Athletic shoes or dance sneakers',
      'Water bottle',
      'Positive energy and smile',
      'No dance experience required'
    ],
    tags: ['dance', 'cardio', 'fun', 'beginner', 'zumba', 'party'],
    price: 1200,
    isActive: true,
    isFeatured: false,
    rating: 4.7,
    reviewsCount: 156,
    enrolledCount: 234,
    trainerEmail: 'jessica.martinez@demogym.test',
    schedule: [
      { day: 'Monday', startTime: '18:00', endTime: '18:50' },
      { day: 'Wednesday', startTime: '18:00', endTime: '18:50' },
      { day: 'Friday', startTime: '18:00', endTime: '18:50' },
      { day: 'Sunday', startTime: '10:00', endTime: '10:50' }
    ]
  },
  {
    name: 'Strength Training 101',
    description: `<h2>Build Your Foundation of Strength</h2>
    <p>Strength Training 101 is a comprehensive introduction to weightlifting and resistance training. This class teaches proper technique, progressive overload principles, and safe training practices to help you build muscle, increase strength, and transform your physique.</p>

    <h3>What You'll Learn</h3>
    <ul>
      <li>Proper lifting technique for all major exercises</li>
      <li>How to design effective workout programs</li>
      <li>Progressive overload and periodization</li>
      <li>Injury prevention and recovery strategies</li>
      <li>Nutrition basics for muscle building</li>
    </ul>

    <h3>Key Exercises Covered</h3>
    <ul>
      <li><strong>Lower Body:</strong> Squats, deadlifts, lunges, leg press</li>
      <li><strong>Upper Body:</strong> Bench press, overhead press, rows</li>
      <li><strong>Back:</strong> Pull-ups, lat pulldowns, rows</li>
      <li><strong>Core:</strong> Planks, ab work, stability exercises</li>
      <li><strong>Accessories:</strong> Biceps, triceps, shoulders, calves</li>
    </ul>

    <h3>Training Philosophy</h3>
    <p>We believe in starting with perfect form using lighter weights, then gradually increasing load as technique improves. This approach minimizes injury risk while maximizing long-term strength gains.</p>

    <h3>Benefits</h3>
    <ul>
      <li>Increased muscle mass and definition</li>
      <li>Higher metabolism and easier weight management</li>
      <li>Stronger bones and connective tissue</li>
      <li>Improved athletic performance</li>
      <li>Better posture and reduced back pain</li>
      <li>Increased confidence and mental toughness</li>
    </ul>

    <p><strong>Perfect for beginners and those returning to strength training after a break.</strong></p>`,
    shortDescription: 'Introduction to weightlifting covering proper technique, programming, and safe practices for building strength and muscle.',
    thumbnail: '/uploads/class1.svg',
    gallery: ['/uploads/class1.svg'],
    duration: 60,
    difficulty: 'Beginner',
    capacity: 18,
    category: 'Strength',
    features: [
      'Technique Focus',
      'Progressive Programming',
      'Injury Prevention',
      'Nutrition Guidance',
      'Small Group Setting',
      'Personalized Attention'
    ],
    requirements: [
      'Athletic shoes with good support',
      'Comfortable workout clothes',
      'Water bottle',
      'Training log or phone for tracking',
      'No experience required'
    ],
    tags: ['strength', 'weightlifting', 'beginner', 'muscle-building', 'technique'],
    price: 1700,
    isActive: true,
    isFeatured: false,
    rating: 4.8,
    reviewsCount: 73,
    enrolledCount: 128,
    trainerEmail: 'sarah.johnson@demogym.test',
    schedule: [
      { day: 'Tuesday', startTime: '08:00', endTime: '09:00' },
      { day: 'Thursday', startTime: '08:00', endTime: '09:00' },
      { day: 'Saturday', startTime: '11:00', endTime: '12:00' }
    ]
  },
  {
    name: 'Advanced Olympic Lifting',
    description: `<h2>Master the Olympic Lifts</h2>
    <p>Advanced Olympic Lifting is for experienced lifters looking to refine their snatch and clean & jerk technique. This specialized class focuses on the technical aspects, power development, and programming strategies used by competitive weightlifters.</p>

    <h3>Prerequisites</h3>
    <p>This class is designed for lifters who already have a solid foundation in Olympic lifting. You should be comfortable with the basic movements and positions before joining.</p>

    <h3>Training Focus</h3>
    <ul>
      <li>Advanced technique refinement</li>
      <li>Power and speed development</li>
      <li>Positional strength work</li>
      <li>Competition preparation</li>
      <li>Video analysis and feedback</li>
      <li>Periodized programming</li>
    </ul>

    <h3>What Makes Olympic Lifting Special</h3>
    <p>The snatch and clean & jerk are the most technical lifts in all of strength sports. They require a perfect combination of strength, speed, power, flexibility, and timing. Mastering these lifts develops athletic qualities that transfer to virtually all sports.</p>

    <h3>Class Structure</h3>
    <ul>
      <li><strong>Warm-Up:</strong> Dynamic mobility and activation</li>
      <li><strong>Technique Work:</strong> Drills and position work</li>
      <li><strong>Main Lifts:</strong> Snatch or clean & jerk focus</li>
      <li><strong>Strength Work:</strong> Squats and pulls</li>
      <li><strong>Accessories:</strong> Targeted weak point work</li>
    </ul>`,
    shortDescription: 'Advanced technical training in Olympic weightlifting for experienced lifters focusing on snatch and clean & jerk.',
    thumbnail: '/uploads/class2.svg',
    gallery: ['/uploads/class2.svg'],
    duration: 90,
    difficulty: 'Advanced',
    capacity: 12,
    category: 'Strength',
    features: [
      'Olympic Lifting Focus',
      'Video Analysis',
      'Personalized Programming',
      'Competition Prep',
      'Small Group Coaching',
      'Advanced Technique'
    ],
    requirements: [
      'Weightlifting shoes (required)',
      'Previous Olympic lifting experience',
      'Athletic wear',
      'Wrist wraps and belt (recommended)',
      'Training log',
      'Minimum 1 year lifting experience'
    ],
    tags: ['olympic-lifting', 'advanced', 'weightlifting', 'strength', 'technical'],
    price: 2500,
    isActive: true,
    isFeatured: false,
    rating: 5.0,
    reviewsCount: 42,
    enrolledCount: 56,
    trainerEmail: 'sarah.johnson@demogym.test',
    schedule: [
      { day: 'Monday', startTime: '17:00', endTime: '18:30' },
      { day: 'Thursday', startTime: '17:00', endTime: '18:30' }
    ]
  },
  {
    name: 'Restorative Yoga & Meditation',
    description: `<h2>Restore, Relax, Rejuvenate</h2>
    <p>Restorative Yoga & Meditation is a gentle, therapeutic class designed to help you unwind, reduce stress, and find inner peace. Using supported poses held for longer periods, this practice activates the parasympathetic nervous system for deep relaxation and healing.</p>

    <h3>What is Restorative Yoga?</h3>
    <p>Unlike more active yoga styles, restorative yoga uses props (bolsters, blankets, blocks) to support your body in comfortable positions. This allows you to completely relax into poses, releasing deep tension without strain or effort.</p>

    <h3>Class Components</h3>
    <ul>
      <li><strong>Gentle Movement:</strong> Slow, mindful warm-up</li>
      <li><strong>Restorative Poses:</strong> 4-6 supported poses held 5-15 minutes each</li>
      <li><strong>Breathwork:</strong> Pranayama techniques for relaxation</li>
      <li><strong>Meditation:</strong> Guided meditation practice</li>
      <li><strong>Yoga Nidra:</strong> Deep relaxation technique</li>
    </ul>

    <h3>Benefits</h3>
    <ul>
      <li>Profound stress reduction</li>
      <li>Improved sleep quality</li>
      <li>Enhanced flexibility through relaxation</li>
      <li>Nervous system regulation</li>
      <li>Emotional balance and well-being</li>
      <li>Pain relief and healing support</li>
    </ul>

    <h3>Perfect For</h3>
    <ul>
      <li>Those dealing with stress or anxiety</li>
      <li>Athletes needing recovery</li>
      <li>Anyone with sleep difficulties</li>
      <li>People managing chronic pain</li>
      <li>Beginners to yoga</li>
      <li>Those seeking mental clarity</li>
    </ul>

    <p><em>All props are provided. Come as you are and leave feeling renewed.</em></p>`,
    shortDescription: 'Gentle therapeutic yoga using supported poses and meditation for deep relaxation, stress relief, and healing.',
    thumbnail: '/uploads/class3.svg',
    gallery: ['/uploads/class3.svg'],
    duration: 75,
    difficulty: 'All Levels',
    capacity: 20,
    category: 'Yoga',
    features: [
      'Supported Poses',
      'Guided Meditation',
      'Breathwork',
      'Stress Relief',
      'All Props Provided',
      'Beginner Friendly'
    ],
    requirements: [
      'Comfortable, loose clothing',
      'Socks (optional)',
      'Open mind',
      'No yoga experience needed',
      'All props provided'
    ],
    tags: ['yoga', 'meditation', 'relaxation', 'stress-relief', 'beginner', 'healing'],
    price: 1400,
    isActive: true,
    isFeatured: false,
    rating: 4.9,
    reviewsCount: 68,
    enrolledCount: 102,
    trainerEmail: 'emily.rodriguez@demogym.test',
    schedule: [
      { day: 'Tuesday', startTime: '19:00', endTime: '20:15' },
      { day: 'Sunday', startTime: '17:00', endTime: '18:15' }
    ]
  },
  {
    name: 'Metabolic Conditioning',
    description: `<h2>Build Your Engine</h2>
    <p>Metabolic Conditioning (MetCon) is designed to improve your body's energy systems, increase work capacity, and enhance overall fitness. This challenging class uses various training modalities to push your limits and develop exceptional conditioning.</p>

    <h3>Training Methods</h3>
    <ul>
      <li>Rowing and assault bike intervals</li>
      <li>Kettlebell complexes</li>
      <li>Barbell conditioning circuits</li>
      <li>Bodyweight challenges</li>
      <li>Sled pushes and pulls</li>
      <li>Battle ropes and plyometrics</li>
    </ul>

    <h3>Energy System Development</h3>
    <p>We train all three energy systems - phosphagen, glycolytic, and oxidative - through varied time domains and intensities. This comprehensive approach builds a well-rounded aerobic and anaerobic capacity.</p>

    <h3>Benefits</h3>
    <ul>
      <li>Increased work capacity</li>
      <li>Improved cardiovascular endurance</li>
      <li>Enhanced recovery between efforts</li>
      <li>Mental toughness development</li>
      <li>Efficient calorie burning</li>
      <li>Better athletic performance</li>
    </ul>`,
    shortDescription: 'High-intensity conditioning class using varied modalities to improve work capacity and overall fitness.',
    thumbnail: '/uploads/class4.svg',
    gallery: ['/uploads/class4.svg'],
    duration: 45,
    difficulty: 'Intermediate',
    capacity: 16,
    category: 'HIIT',
    features: [
      'Varied Equipment',
      'Energy System Training',
      'High Intensity',
      'Scalable Workouts',
      'Performance Focus',
      'Small Groups'
    ],
    requirements: [
      'Athletic shoes',
      'Workout clothes',
      'Water bottle',
      'Towel',
      'Moderate fitness level',
      'Heart rate monitor (optional)'
    ],
    tags: ['conditioning', 'metcon', 'cardio', 'endurance', 'high-intensity'],
    price: 1600,
    isActive: true,
    isFeatured: false,
    rating: 4.7,
    reviewsCount: 54,
    enrolledCount: 89,
    trainerEmail: 'marcus.chen@demogym.test',
    schedule: [
      { day: 'Tuesday', startTime: '17:00', endTime: '17:45' },
      { day: 'Thursday', startTime: '17:00', endTime: '17:45' },
      { day: 'Saturday', startTime: '08:00', endTime: '08:45' }
    ]
  }
];

// Get trainer by email
async function getTrainerByEmail(email) {
  return await Trainer.findOne({ email });
}

// Create gym classes
async function createGymClasses() {
  console.log('🏋️ Creating gym classes...\n');

  const classes = [];

  for (let i = 0; i < classTemplates.length; i++) {
    const classData = classTemplates[i];

    // Check if class already exists
    const existingClass = await GymClass.findOne({ name: classData.name });
    if (existingClass) {
      console.log(`⚠️  Class already exists: ${classData.name}`);
      classes.push(existingClass);
      continue;
    }

    // Get trainer
    const trainer = await getTrainerByEmail(classData.trainerEmail);
    if (!trainer) {
      console.log(`❌ Trainer not found for email: ${classData.trainerEmail}`);
      continue;
    }

    // Add instructor to schedule
    const scheduleWithInstructor = classData.schedule.map(s => ({
      ...s,
      instructor: trainer._id,
      instructorName: trainer.name
    }));

    // Create class object
    const gymClass = new GymClass({
      name: classData.name,
      description: classData.description,
      shortDescription: classData.shortDescription,
      thumbnail: classData.thumbnail,
      gallery: classData.gallery,
      schedule: scheduleWithInstructor,
      duration: classData.duration,
      difficulty: classData.difficulty,
      capacity: classData.capacity,
      features: classData.features,
      requirements: classData.requirements,
      category: classData.category,
      tags: classData.tags,
      isActive: classData.isActive,
      isFeatured: classData.isFeatured,
      price: classData.price,
      rating: classData.rating,
      reviewsCount: classData.reviewsCount,
      enrolledCount: classData.enrolledCount
    });

    try {
      const saved = await gymClass.save();
      classes.push(saved);
      console.log(`✅ Created class: ${classData.name}`);
      console.log(`   👨‍🏫 Instructor: ${trainer.name}`);
      console.log(`   ⏱️  Duration: ${classData.duration} minutes`);
      console.log(`   📊 Difficulty: ${classData.difficulty}`);
      console.log(`   ⭐ Rating: ${classData.rating}/5.0 (${classData.reviewsCount} reviews)`);
      console.log(`   👥 Enrolled: ${classData.enrolledCount} students`);
      console.log(`   💰 Price: PKR ${classData.price}\n`);
    } catch (error) {
      console.error(`❌ Error creating class ${classData.name}:`, error.message);
    }
  }

  return classes;
}

async function main() {
  try {
    await connectDB();
    // Every gym has its own database: --gym <slug> picks which one.
    enterContext(await resolveGymContextFromArgs());
    console.log('🚀 Starting gym class seeder...\n');

    const classes = await createGymClasses();

    console.log(`\n🎉 Successfully created/found ${classes.length} gym classes!`);

    // Show summary
    const totalClasses = await GymClass.countDocuments();
    const activeClasses = await GymClass.countDocuments({ isActive: true });
    const featuredClasses = await GymClass.countDocuments({ isFeatured: true });

    console.log('\n📊 Database Summary:');
    console.log(`- Total classes: ${totalClasses}`);
    console.log(`- Active classes: ${activeClasses}`);
    console.log(`- Featured classes: ${featuredClasses}`);

    // Show classes by category
    console.log('\n📋 Classes by Category:');
    const categories = ['Yoga', 'HIIT', 'Strength', 'Dance', 'Cardio'];
    for (const category of categories) {
      const count = await GymClass.countDocuments({ category });
      if (count > 0) {
        console.log(`- ${category}: ${count}`);
      }
    }

    // Show all classes
    const allClasses = await GymClass.find()
      .populate('schedule.instructor', 'name')
      .sort({ order: 1 });

    console.log('\n🏋️ All Classes:');
    allClasses.forEach((gymClass, idx) => {
      const instructor = gymClass.schedule.length > 0 && gymClass.schedule[0].instructor
        ? gymClass.schedule[0].instructor.name
        : 'No instructor';
      console.log(`${idx + 1}. ${gymClass.name}`);
      console.log(`   Category: ${gymClass.category} | Difficulty: ${gymClass.difficulty}`);
      console.log(`   Duration: ${gymClass.duration}min | Instructor: ${instructor}`);
      console.log(`   Rating: ${gymClass.rating}/5.0 | Enrolled: ${gymClass.enrolledCount}`);
      console.log(`   Featured: ${gymClass.isFeatured ? 'Yes' : 'No'} | Price: PKR ${gymClass.price}`);
      console.log('');
    });

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed.');
  }
}

main();
