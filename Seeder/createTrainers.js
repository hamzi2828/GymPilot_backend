// createTrainers.js - Create trainers with comprehensive data

const mongoose = require('mongoose');
const { enterContext, resolveGymContextFromArgs } = require('../scripts/lib/tenantScript');
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

// Trainer data templates
const trainerTemplates = [
  {
    name: 'Sarah Johnson',
    role: 'Head Personal Trainer & Strength Coach',
    bio: 'Sarah is a certified personal trainer with over 10 years of experience in strength training and athletic conditioning. She specializes in helping clients build functional strength and achieve their fitness goals through personalized training programs. Her approach combines traditional strength training with modern sports science to deliver exceptional results. Sarah has worked with professional athletes, busy professionals, and fitness enthusiasts of all levels.',
    image: '/uploads/trainer-1.svg',
    email: 'sarah.johnson@demogym.test',
    phone: '+1 (555) 123-4567',
    specialties: [
      'Strength Training',
      'Olympic Weightlifting',
      'Athletic Conditioning',
      'Functional Fitness',
      'Sports Performance'
    ],
    certifications: [
      'NSCA Certified Strength and Conditioning Specialist (CSCS)',
      'USA Weightlifting Level 2 Coach',
      'Precision Nutrition Level 1',
      'TRX Suspension Training Certified'
    ],
    experience: 10,
    social: {
      instagram: '@sarahfitcoach',
      facebook: 'sarahjohnsonfit',
      twitter: '@sarahtrains',
      youtube: 'SarahJohnsonFitness',
      linkedin: 'sarah-johnson-fitness'
    },
    availability: [
      { day: 'Monday', startTime: '06:00', endTime: '20:00' },
      { day: 'Tuesday', startTime: '06:00', endTime: '20:00' },
      { day: 'Wednesday', startTime: '06:00', endTime: '20:00' },
      { day: 'Thursday', startTime: '06:00', endTime: '20:00' },
      { day: 'Friday', startTime: '06:00', endTime: '18:00' },
      { day: 'Saturday', startTime: '08:00', endTime: '14:00' }
    ],
    isActive: true,
    isFeatured: true,
    rating: 4.9,
    totalClasses: 1250
  },
  {
    name: 'Marcus Chen',
    role: 'HIIT & Cardio Specialist',
    bio: 'Marcus brings energy and expertise to every high-intensity interval training session. With a background in competitive athletics and exercise physiology, he creates challenging yet achievable workouts that maximize calorie burn and improve cardiovascular fitness. His classes are known for their perfect blend of intensity, motivation, and fun. Marcus believes that fitness should be enjoyable and sustainable for long-term success.',
    image: '/uploads/trainer2.svg',
    email: 'marcus.chen@demogym.test',
    phone: '+1 (555) 234-5678',
    specialties: [
      'HIIT Training',
      'Cardiovascular Conditioning',
      'Fat Loss',
      'Metabolic Training',
      'Boot Camp Classes'
    ],
    certifications: [
      'ACE Certified Personal Trainer',
      'ACSM Exercise Physiologist',
      'Tabata Bootcamp Certified',
      'CPR/AED Certified'
    ],
    experience: 7,
    social: {
      instagram: '@marcushiit',
      facebook: 'marcuschenfit',
      twitter: '@marcusfit',
      youtube: 'MarcusChenHIIT'
    },
    availability: [
      { day: 'Monday', startTime: '05:30', endTime: '19:00' },
      { day: 'Tuesday', startTime: '05:30', endTime: '19:00' },
      { day: 'Wednesday', startTime: '05:30', endTime: '19:00' },
      { day: 'Thursday', startTime: '05:30', endTime: '19:00' },
      { day: 'Friday', startTime: '05:30', endTime: '17:00' },
      { day: 'Sunday', startTime: '09:00', endTime: '13:00' }
    ],
    isActive: true,
    isFeatured: true,
    rating: 4.8,
    totalClasses: 980
  },
  {
    name: 'Emily Rodriguez',
    role: 'Yoga & Pilates Instructor',
    bio: 'Emily is a passionate yoga and Pilates instructor dedicated to helping students find balance, flexibility, and inner peace. With her gentle yet effective teaching style, she guides practitioners of all levels through mindful movement and breath work. Emily completed her 500-hour yoga teacher training in India and has studied various styles including Vinyasa, Hatha, and Restorative yoga. She believes in the transformative power of mindful movement.',
    image: '/uploads/trainer3.svg',
    email: 'emily.rodriguez@demogym.test',
    phone: '+1 (555) 345-6789',
    specialties: [
      'Vinyasa Yoga',
      'Hatha Yoga',
      'Pilates Mat & Reformer',
      'Flexibility Training',
      'Meditation & Mindfulness',
      'Prenatal Yoga'
    ],
    certifications: [
      '500-Hour Registered Yoga Teacher (RYT-500)',
      'Pilates Mat Certification (PMA)',
      'Barre Above Instructor',
      'Prenatal Yoga Certified',
      'Meditation Teacher Training'
    ],
    experience: 8,
    social: {
      instagram: '@emilyflow',
      facebook: 'emilyrodriguezyoga',
      youtube: 'EmilyRodriguezYoga',
      linkedin: 'emily-rodriguez-yoga'
    },
    availability: [
      { day: 'Monday', startTime: '07:00', endTime: '18:00' },
      { day: 'Tuesday', startTime: '07:00', endTime: '18:00' },
      { day: 'Wednesday', startTime: '07:00', endTime: '18:00' },
      { day: 'Thursday', startTime: '07:00', endTime: '18:00' },
      { day: 'Friday', startTime: '07:00', endTime: '16:00' },
      { day: 'Saturday', startTime: '08:00', endTime: '12:00' },
      { day: 'Sunday', startTime: '08:00', endTime: '12:00' }
    ],
    isActive: true,
    isFeatured: true,
    rating: 5.0,
    totalClasses: 1450
  },
  {
    name: 'David Thompson',
    role: 'CrossFit Coach & Nutrition Specialist',
    bio: 'David is a former competitive CrossFit athlete turned coach who brings intense passion and technical expertise to his training sessions. He specializes in functional fitness movements and believes in building well-rounded athletes. Beyond the gym, David is also a certified nutrition coach who helps clients optimize their diet for performance and recovery. His holistic approach addresses both training and nutrition to help clients achieve remarkable transformations.',
    image: '/uploads/trainer4.svg',
    email: 'david.thompson@demogym.test',
    phone: '+1 (555) 456-7890',
    specialties: [
      'CrossFit Training',
      'Functional Fitness',
      'Olympic Lifting',
      'Nutrition Coaching',
      'Competition Prep',
      'Mobility Work'
    ],
    certifications: [
      'CrossFit Level 3 Trainer (CF-L3)',
      'USA Weightlifting Sports Performance Coach',
      'Precision Nutrition Level 2',
      'FMS Level 1',
      'Strongfirst Kettlebell Certified'
    ],
    experience: 9,
    social: {
      instagram: '@davidcrossfit',
      facebook: 'davidthompsonfit',
      twitter: '@coachthompson',
      youtube: 'DavidThompsonCrossFit'
    },
    availability: [
      { day: 'Monday', startTime: '06:00', endTime: '20:00' },
      { day: 'Tuesday', startTime: '06:00', endTime: '20:00' },
      { day: 'Wednesday', startTime: '06:00', endTime: '20:00' },
      { day: 'Thursday', startTime: '06:00', endTime: '20:00' },
      { day: 'Friday', startTime: '06:00', endTime: '19:00' },
      { day: 'Saturday', startTime: '07:00', endTime: '15:00' }
    ],
    isActive: true,
    isFeatured: true,
    rating: 4.9,
    totalClasses: 1180
  },
  {
    name: 'Jessica Martinez',
    role: 'Group Fitness & Dance Instructor',
    bio: 'Jessica is an energetic and motivating group fitness instructor who makes every class feel like a party. With a background in dance and choreography, she brings creativity and fun to traditional fitness formats. Her classes range from dance-based cardio to strength training, always infused with great music and positive vibes. Jessica is passionate about creating an inclusive environment where everyone feels welcome and empowered to move their body.',
    image: '/uploads/trainer5.svg',
    email: 'jessica.martinez@demogym.test',
    phone: '+1 (555) 567-8901',
    specialties: [
      'Zumba & Dance Fitness',
      'Group Exercise',
      'Body Pump',
      'Spin Classes',
      'Barre Fitness',
      'Senior Fitness'
    ],
    certifications: [
      'AFAA Group Fitness Instructor',
      'Zumba Instructor Certification',
      'Indoor Cycling Certification',
      'Barre Instructor Training',
      'Silver Sneakers Certified',
      'Les Mills Body Pump Certified'
    ],
    experience: 6,
    social: {
      instagram: '@jessicamoves',
      facebook: 'jessicamartinezfit',
      twitter: '@jessfit',
      youtube: 'JessicaMartinezFitness'
    },
    availability: [
      { day: 'Monday', startTime: '08:00', endTime: '19:00' },
      { day: 'Tuesday', startTime: '08:00', endTime: '19:00' },
      { day: 'Wednesday', startTime: '08:00', endTime: '19:00' },
      { day: 'Thursday', startTime: '08:00', endTime: '19:00' },
      { day: 'Friday', startTime: '08:00', endTime: '18:00' },
      { day: 'Saturday', startTime: '09:00', endTime: '14:00' },
      { day: 'Sunday', startTime: '10:00', endTime: '13:00' }
    ],
    isActive: true,
    isFeatured: false,
    rating: 4.7,
    totalClasses: 875
  }
];

// Create trainers
async function createTrainers() {
  console.log('👨‍🏫 Creating trainers...\n');

  const trainers = [];

  for (let i = 0; i < trainerTemplates.length; i++) {
    const trainerData = trainerTemplates[i];

    // Check if trainer already exists
    const existingTrainer = await Trainer.findOne({ email: trainerData.email });
    if (existingTrainer) {
      console.log(`⚠️  Trainer already exists: ${trainerData.name} (${trainerData.email})`);
      trainers.push(existingTrainer);
      continue;
    }

    const trainer = new Trainer(trainerData);

    try {
      const saved = await trainer.save();
      trainers.push(saved);
      console.log(`✅ Created trainer: ${trainerData.name} - ${trainerData.role}`);
      console.log(`   📧 Email: ${trainerData.email}`);
      console.log(`   ⭐ Rating: ${trainerData.rating}/5.0`);
      console.log(`   📊 Total Classes: ${trainerData.totalClasses}`);
      console.log(`   🎯 Specialties: ${trainerData.specialties.slice(0, 3).join(', ')}...\n`);
    } catch (error) {
      console.error(`❌ Error creating trainer ${trainerData.name}:`, error.message);
    }
  }

  return trainers;
}

async function main() {
  try {
    await connectDB();
    // Every gym has its own database: --gym <slug> picks which one.
    enterContext(await resolveGymContextFromArgs());
    console.log('🚀 Starting trainer seeder...\n');

    const trainers = await createTrainers();

    console.log(`\n🎉 Successfully created/found ${trainers.length} trainers!`);

    // Show summary
    const totalTrainers = await Trainer.countDocuments();
    const activeTrainers = await Trainer.countDocuments({ isActive: true });
    const featuredTrainers = await Trainer.countDocuments({ isFeatured: true });

    console.log('\n📊 Database Summary:');
    console.log(`- Total trainers: ${totalTrainers}`);
    console.log(`- Active trainers: ${activeTrainers}`);
    console.log(`- Featured trainers: ${featuredTrainers}`);

    // Show all trainers with details
    const allTrainers = await Trainer.find().sort({ order: 1 });
    console.log('\n👥 All Trainers:');
    allTrainers.forEach((trainer, idx) => {
      console.log(`${idx + 1}. ${trainer.name}`);
      console.log(`   Role: ${trainer.role}`);
      console.log(`   Rating: ${trainer.rating}/5.0 | Classes: ${trainer.totalClasses}`);
      console.log(`   Featured: ${trainer.isFeatured ? 'Yes' : 'No'} | Active: ${trainer.isActive ? 'Yes' : 'No'}`);
      console.log(`   Specialties: ${trainer.specialties.slice(0, 2).join(', ')}`);
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
