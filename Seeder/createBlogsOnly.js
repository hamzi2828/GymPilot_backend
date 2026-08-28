// createBlogsOnly.js - Create blogs using existing categories and authors

const mongoose = require('mongoose');
const BlogCategory = require('../src/models/blogCategory');
const Blog = require('../src/models/blogModel');
const Author = require('../src/models/authorModel');

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

// Available images from uploads folder
const allImages = [
  '/uploads/1757006235529-741331007-gym-5.svg',
  '/uploads/1757006537365-644695970-gym-2.svg',
  '/uploads/1757006694046-55411946-gym-3.svg',
  '/uploads/1757006736978-675299171-gym-4.svg',
  '/uploads/1757006771834-569938326-gym-5.svg',
  '/uploads/1757006840795-626253440-gym-2.svg',
  '/uploads/1757008029072-398978864-Orange_gym-7.svg',
  '/uploads/1757008029072-645677855-Orange_0_gym-bdetail1.svg',
  '/uploads/1757008029078-164611448-Orange_1_gym-bdetail2.svg',
  '/uploads/1757008029080-912633109-Orange_2_gym-bdetail3.svg',
  '/uploads/1757008029084-67767631-Green_1_gym-blog-2.svg',
  '/uploads/1757008029084-70113638-Green_gym-6.svg',
  '/uploads/1757008029084-92436068-Green_0_gym-blog-1.svg',
  '/uploads/1757008029086-533245630-Green_2_gym-blog-3.svg',
  '/uploads/1757008669072-779073397-gym-6.svg',
  '/uploads/1757008669073-854684101-gym-bdetail1.svg',
  '/uploads/1757008669078-172119998-gym-bdetail2.svg',
  '/uploads/1757008669081-632390063-gym-bdetail3.svg',
  '/uploads/1757008669084-649084708-gym-bdetail3.svg',
  '/uploads/1757008669086-773753972-gym-blog-2.svg'
];

// Helper functions
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Blog content templates
const blogTemplates = [
  {
    title: '10 Essential Exercises for Building Core Strength',
    content: `<h2>Why Core Strength Matters</h2>
    <p>A strong core is the foundation of all movement and athletic performance. Whether you're lifting weights, running, or simply going about your daily activities, your core muscles provide stability and power transfer throughout your body.</p>
    
    <h3>The Top 10 Core Exercises</h3>
    <ol>
      <li><strong>Planks</strong> - Hold for 30-60 seconds</li>
      <li><strong>Dead Bugs</strong> - 10 reps each side</li>
      <li><strong>Bird Dogs</strong> - 8 reps each side</li>
      <li><strong>Russian Twists</strong> - 20 reps</li>
      <li><strong>Mountain Climbers</strong> - 30 seconds</li>
      <li><strong>Bicycle Crunches</strong> - 15 reps each side</li>
      <li><strong>Hollow Body Hold</strong> - 20-30 seconds</li>
      <li><strong>Side Planks</strong> - 20-30 seconds each side</li>
      <li><strong>Bear Crawl</strong> - 10 steps forward and back</li>
      <li><strong>Leg Raises</strong> - 12-15 reps</li>
    </ol>
    
    <h3>How to Get Started</h3>
    <p>Begin with 2-3 exercises and gradually build up to the full routine. Focus on proper form over speed or intensity.</p>
    
    <p><em>Remember, consistency is key in your fitness journey. Start where you are, use what you have, and do what you can!</em></p>`,
    tags: ['core', 'strength', 'exercises', 'fitness']
  },
  {
    title: 'Complete Guide to Pre and Post Workout Nutrition',
    content: `<h2>Fueling Your Workouts</h2>
    <p>Proper nutrition around your workouts can significantly impact your performance, recovery, and results. Here's everything you need to know about timing your meals and choosing the right foods.</p>
    
    <h3>Pre-Workout Nutrition</h3>
    <p>Eat 1-3 hours before training:</p>
    <ul>
      <li><strong>Carbohydrates</strong> for energy</li>
      <li><strong>Moderate protein</strong></li>
      <li><strong>Low fat and fiber</strong></li>
    </ul>
    
    <blockquote>
      <p><em>"The best pre-workout meal combines easily digestible carbs with a moderate amount of protein."</em></p>
    </blockquote>
    
    <h3>Post-Workout Recovery</h3>
    <p>Within 30-60 minutes after training:</p>
    <ul>
      <li>Protein for muscle repair (20-40g)</li>
      <li>Carbohydrates to replenish glycogen</li>
      <li>Adequate hydration</li>
    </ul>
    
    <h3>Sample Meal Ideas</h3>
    <p><strong>Pre-workout:</strong> Banana with almond butter, oatmeal with berries, or Greek yogurt with honey.</p>
    <p><strong>Post-workout:</strong> Protein smoothie, chicken and rice, or chocolate milk and a banana.</p>
    
    <p><strong>Remember:</strong> Everyone's nutritional needs are different. Experiment to find what works best for your body and training schedule!</p>`,
    tags: ['nutrition', 'pre-workout', 'post-workout', 'recovery']
  },
  {
    title: 'Home Gym Setup: Essential Equipment on Any Budget',
    content: `<h2>Building Your Home Gym</h2>
    <p>Creating an effective home gym doesn't require breaking the bank. With the right equipment choices, you can get a complete workout from the comfort of your own space.</p>
    
    <h3>Budget-Friendly Essentials ($100-300)</h3>
    <ul>
      <li><strong>Resistance Bands Set</strong> - Versatile and space-efficient</li>
      <li><strong>Adjustable Dumbbells</strong> - Core strength training tool</li>
      <li><strong>Yoga Mat</strong> - For floor exercises and stretching</li>
      <li><strong>Jump Rope</strong> - Excellent cardio option</li>
    </ul>
    
    <h3>Mid-Range Options ($300-800)</h3>
    <ul>
      <li>Adjustable dumbbells (heavier weights)</li>
      <li>Kettlebell set</li>
      <li>Pull-up bar</li>
      <li>Stability ball</li>
    </ul>
    
    <h3>Premium Setup ($800+)</h3>
    <p>For those ready to invest more:</p>
    <ul>
      <li>Power rack or squat stand</li>
      <li>Olympic barbell and plates</li>
      <li>Adjustable bench</li>
      <li>Cable machine or suspension trainer</li>
    </ul>
    
    <h3>Space-Saving Tips</h3>
    <p>Maximize your space with wall-mounted storage, foldable equipment, and multi-purpose tools that serve multiple functions.</p>
    
    <p><strong>Pro Tip:</strong> Start small and build your gym over time. Quality equipment will last years and provide better value than cheap alternatives.</p>`,
    tags: ['home-gym', 'equipment', 'budget', 'setup']
  },
  {
    title: 'The Science of Rest Days: Why Recovery Matters',
    content: `<h2>Understanding Recovery</h2>
    <p>Rest days aren't just about being lazy – they're a crucial component of any effective fitness program. Understanding the science behind recovery can help you optimize your training results.</p>
    
    <h3>What Happens During Rest</h3>
    <p>When you rest, your body:</p>
    <ul>
      <li>Repairs muscle tissue damage from training</li>
      <li>Replenishes energy stores (glycogen)</li>
      <li>Strengthens neural pathways</li>
      <li>Reduces inflammation</li>
      <li>Balances hormones</li>
    </ul>
    
    <h3>Active vs. Passive Recovery</h3>
    <p><strong>Passive Recovery:</strong> Complete rest with minimal physical activity.</p>
    <p><strong>Active Recovery:</strong> Light movement like walking, gentle yoga, or easy swimming.</p>
    
    <h3>Signs You Need More Recovery</h3>
    <ul>
      <li>Persistent muscle soreness</li>
      <li>Decreased performance</li>
      <li>Elevated resting heart rate</li>
      <li>Mood changes or irritability</li>
      <li>Frequent illness</li>
    </ul>
    
    <h3>Optimizing Your Recovery</h3>
    <ol>
      <li><strong>Sleep:</strong> 7-9 hours of quality sleep</li>
      <li><strong>Nutrition:</strong> Adequate protein and overall calories</li>
      <li><strong>Hydration:</strong> Consistent water intake</li>
      <li><strong>Stress Management:</strong> Meditation, breathing exercises</li>
      <li><strong>Gentle Movement:</strong> Light stretching or walking</li>
    </ol>
    
    <p><em>Remember: Recovery is when the magic happens. Don't neglect this crucial aspect of your fitness journey!</em></p>`,
    tags: ['recovery', 'rest-days', 'science', 'wellness']
  },
  {
    title: 'Beginner\'s Guide to Weight Training',
    content: `<h2>Starting Your Weight Training Journey</h2>
    <p>Weight training can seem intimidating for beginners, but with the right approach, anyone can build strength safely and effectively. This guide will help you get started with confidence.</p>
    
    <h3>Basic Principles</h3>
    <p><strong>Progressive Overload:</strong> Gradually increase weight, reps, or sets over time.</p>
    <p><strong>Form First:</strong> Perfect technique before adding weight.</p>
    <p><strong>Consistency:</strong> Regular training produces the best results.</p>
    
    <h3>Essential Movements for Beginners</h3>
    <ol>
      <li><strong>Squat</strong> - Builds leg and core strength</li>
      <li><strong>Deadlift</strong> - Works posterior chain</li>
      <li><strong>Bench Press</strong> - Develops chest and arms</li>
      <li><strong>Row</strong> - Strengthens back muscles</li>
      <li><strong>Overhead Press</strong> - Builds shoulder stability</li>
    </ol>
    
    <h3>Sample Beginner Routine</h3>
    <p><strong>Week 1-2:</strong> 2 sets of 8-10 reps with bodyweight or light weights</p>
    <p><strong>Week 3-4:</strong> 2-3 sets of 8-12 reps with moderate weight</p>
    <p><strong>Week 5+:</strong> 3 sets of 6-12 reps, progressively increasing weight</p>
    
    <h3>Safety Tips</h3>
    <ul>
      <li>Always warm up before lifting</li>
      <li>Use a spotter for heavy lifts</li>
      <li>Don't ego lift - choose appropriate weights</li>
      <li>Listen to your body and rest when needed</li>
      <li>Consider working with a trainer initially</li>
    </ul>
    
    <p><strong>Final Thought:</strong> Everyone starts somewhere. Focus on learning proper form and being consistent. The strength will come!</p>`,
    tags: ['beginner', 'weight-training', 'strength', 'guide']
  }
];

// Additional blog titles for more variety
const additionalBlogTitles = [
  'HIIT Workouts: Maximum Results in Minimum Time',
  '5 Common Gym Mistakes and How to Avoid Them',
  'The Ultimate Guide to Meal Prep for Fitness',
  'Yoga for Athletes: Flexibility and Recovery',
  'Building Muscle After 40: A Complete Guide',
  'Cardio vs Strength Training: Finding the Balance'
];

// Create blogs using existing authors and categories
async function createBlogs() {
  console.log('📝 Creating blogs...');
  
  // Get existing authors and categories
  const authors = await Author.find({ active: true });
  const categories = await BlogCategory.find({ active: true });
  
  console.log(`Found ${authors.length} authors and ${categories.length} categories`);
  
  if (authors.length === 0 || categories.length === 0) {
    console.log('❌ Need at least 1 author and 1 category to create blogs');
    return [];
  }
  
  const blogs = [];
  const allBlogData = [...blogTemplates];
  
  // Add additional blogs with shorter content
  additionalBlogTitles.forEach(title => {
    allBlogData.push({
      title,
      content: `<h2>${title}</h2>
      <p>This is comprehensive guide about ${title.toLowerCase()}. Learn the fundamentals, advanced techniques, and practical tips to improve your fitness journey.</p>
      
      <h3>Key Points</h3>
      <ul>
        <li>Understanding the basics</li>
        <li>Common mistakes to avoid</li>
        <li>Practical implementation tips</li>
        <li>Progress tracking methods</li>
      </ul>
      
      <p><strong>Remember:</strong> Consistency and proper form are more important than intensity. Start slow, be patient, and enjoy the process!</p>
      
      <p><em>Your fitness journey is unique to you. Trust the process and celebrate every small victory along the way!</em></p>`,
      tags: title.toLowerCase().split(' ').slice(0, 3)
    });
  });
  
  // Create up to 15 blogs
  const blogsToCreate = allBlogData.slice(0, 15);
  
  for (let i = 0; i < blogsToCreate.length; i++) {
    const blogData = blogsToCreate[i];
    const category = getRandomElement(categories);
    const author = getRandomElement(authors);
    
    const blog = new Blog({
      title: blogData.title,
      content: blogData.content,
      categoryId: category._id,
      status: Math.random() > 0.2 ? 'published' : 'draft', // 80% published
      image: getRandomElement(allImages),
      thumbnail: getRandomElement(allImages),
      author: author._id,
      tags: blogData.tags,
      views: Math.floor(Math.random() * 2000),
      metaTitle: blogData.title.slice(0, 60),
      metaDescription: blogData.content.replace(/<[^>]*>/g, '').slice(0, 155),
      metaKeywords: blogData.tags.join(', '),
      metaSchema: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": blogData.title,
        "description": blogData.content.replace(/<[^>]*>/g, '').slice(0, 155),
        "image": getRandomElement(allImages),
        "author": {
          "@type": "Person",
          "name": author.name
        },
        "publisher": {
          "@type": "Organization",
          "name": "Inked Wear",
          "logo": {
            "@type": "ImageObject",
            "url": "/images/logo.png"
          }
        }
      })
    });
    
    try {
      const saved = await blog.save();
      blogs.push(saved);
      console.log(`✅ Created blog: ${blogData.title}`);
    } catch (error) {
      console.error(`❌ Error creating blog ${blogData.title}:`, error.message);
    }
  }
  
  return blogs;
}

async function main() {
  try {
    await connectDB();
    console.log('🚀 Creating blogs with existing data...\n');
    
    const blogs = await createBlogs();
    
    console.log(`\n🎉 Successfully created ${blogs.length} blogs!`);
    
    // Show summary
    const totalCategories = await BlogCategory.countDocuments();
    const totalAuthors = await Author.countDocuments();
    const totalBlogs = await Blog.countDocuments();
    
    console.log('\n📊 Database Summary:');
    console.log(`- Blog categories: ${totalCategories}`);
    console.log(`- Authors: ${totalAuthors}`);
    console.log(`- Blogs: ${totalBlogs}`);
    console.log(`- Published blogs: ${await Blog.countDocuments({ status: 'published' })}`);
    console.log(`- Draft blogs: ${await Blog.countDocuments({ status: 'draft' })}`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed.');
  }
}

main();