require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { mongoose, ensureConnection } = require('./src/config/mongo');
const app = express();
const port = process.env.PORT || 4000;
const allRoutes = require('./src/routes/allRoutes');

// Vercel puts a proxy in front of this, so the client address arrives in
// X-Forwarded-For rather than on the socket. Without this, express reports
// the proxy's address as req.ip and every request in the world shares one
// rate-limit bucket. One hop, not `true`: trusting the whole chain would let
// a caller forge the header and pick their own bucket.
app.set('trust proxy', 1);

const gymfolioRoutes = require('./src/gymfolio/routes/gymfolioRoutes');
const desktopRoutes = require('./src/attendance/routes/desktopRoutes');
const attendanceAdminRoutes = require('./src/attendance/routes/adminRoutes');
const accountsRoutes = require('./src/accounts/routes/accountsRoutes');

// ---------------------------------------------------------------------------
// Security headers
//
// Two of helmet's defaults are wrong for this app and are overridden below.
// Both would break working pages if left alone, which is why they are spelled
// out rather than accepted silently:
//
//   crossOriginResourcePolicy — defaults to 'same-origin', which would stop
//     the frontend on :3000 loading a single image from /uploads on :4000.
//     Every product photo, trainer portrait and hero slide on the site is
//     served from there.
//
//   contentSecurityPolicy — disabled globally because this server returns JSON
//     and images, not HTML, so a page-level CSP has nothing to protect here.
//     A targeted one IS applied to /uploads below, where it does real work.
// ---------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false
  })
);

// CORS: allow frontend to access backend
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';
const GYMFOLIO_URL = process.env.GYMFOLIO_URL || 'http://localhost:3000';
app.use(cors({
  origin: [FRONTEND_ORIGIN, GYMFOLIO_URL, 'http://localhost:3000', 'http://localhost:3001', 'https://www.inkedwearpk.com', 'https://www.thejymor.com', 'https://thejymor.com'],
  credentials: true,
}));

// Parse JSON (but not for webhook endpoint)
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payment/webhook') {
    next();
  } else {
    express.json({ limit: '50mb' })(req, res, next);
  }
});

// Also add urlencoded parser for form data
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ---------------------------------------------------------------------------
// Uploaded files
//
// These are visitor- and admin-supplied bytes served back from our own origin,
// which is the setup that turns an image upload into stored XSS. The specific
// risk is SVG: it is an image everywhere it is used on this site (inside an
// <img>, where scripts never run) but it is also an XML document that CAN run
// script when a browser is pointed straight at the file. Thirty-six of them
// are already uploaded and in use, so refusing to serve them is not an option.
//
// The headers below neuter that without touching a single working image:
//
//   CSP sandbox + default-src 'none' — an SVG opened directly is dropped into
//     an opaque origin with scripting off and no permission to load anything,
//     so there is nothing left for an injected <script> to do. Rendering
//     inside <img> is unaffected: that path never ran script to begin with.
//   X-Content-Type-Options: nosniff — stops a browser deciding for itself that
//     a file we called an image is really HTML.
//
// Content-Disposition: attachment on SVG was considered and rejected. It is
// the other common mitigation, but browsers are not consistent about ignoring
// it for subresource loads, and being wrong about that would blank out
// thirty-six images that are live on the site today. The sandbox above already
// closes the hole; this would only have been belt-and-braces bought with a
// real risk of breaking working pages.
// ---------------------------------------------------------------------------
app.use(
  '/uploads',
  express.static(path.resolve(__dirname, 'uploads'), {
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    }
  })
);

// Middleware to ensure MongoDB connection for serverless environments
app.use('/api', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
});



// Gymfolio routes (classes, trainers, packages, package orders/registrations, payments)
app.use('/api/gymfolio', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
}, gymfolioRoutes);

// Front-desk attendance app (GymPilot_desktopApp). Native Windows client, so
// no CORS entry is needed -- it is not a browser.
app.use('/api/desktop', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      success: false,
      message: 'Database connection failed. Please try again in a moment.'
    });
  }
}, desktopRoutes);

// Admin panel's read-only view of the same attendance data. Browser client,
// so it goes through the CORS list above and an admin JWT rather than a
// desktop token.
app.use('/api/attendance', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      success: false,
      message: 'Database connection failed. Please try again in a moment.'
    });
  }
}, attendanceAdminRoutes);

// Books: sales reports, expenses and the asset register.
app.use('/api/accounts', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      success: false,
      message: 'Database connection failed. Please try again in a moment.'
    });
  }
}, accountsRoutes);

// Add the same middleware for other routes that need database
app.use('/', async (req, res, next) => {
  // Skip for static routes and non-database routes
  if (req.path.startsWith('/uploads') || req.path === '/' || req.path === '/health') {
    return next();
  }
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
});

// Welcome route
app.get('/', (req, res) => {
  try {
    const mongoose = require('mongoose');

    res.json({
      message: 'GymPilot API',
      status: 'running',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      database: {
        status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        readyState: mongoose.connection.readyState
      },
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    console.error('Error in welcome route:', error);
    res.status(500).json({
      message: 'GymPilot API',
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/jobs/reminders
//
// The daily job, exposed over HTTP because this backend is serverless: there
// is no long-lived process here to hold a scheduler, so the schedule has to
// live outside and poke this endpoint. Vercel Cron, GitHub Actions and an
// ordinary crontab with `curl` all work.
//
// Guarded by a shared secret rather than a user session, because the caller is
// a machine with no account. Without CRON_SECRET set the route refuses
// everything — failing closed, so forgetting to configure it cannot leave an
// open endpoint that emails the whole membership on demand.
//
//   curl -X POST https://api.yourgym.com/api/jobs/reminders \
//        -H "Authorization: Bearer $CRON_SECRET"
//
// Registered for GET as well as POST, which is not an oversight: Vercel Cron
// only ever issues GET, and it is the scheduler this app is deployed under. A
// GET with side effects is normally wrong, but the alternative is either no
// schedule at all or a second service whose only job is to turn a GET into a
// POST. The shared secret is what keeps it from being triggered by anything
// that merely follows links.
// ---------------------------------------------------------------------------
async function runRemindersRoute(req, res) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return res.status(503).json({
      success: false,
      message: 'Scheduled jobs are disabled: CRON_SECRET is not configured.'
    });
  }

  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  // Constant-time compare. Buffers must match in length first, or timingSafeEqual
  // throws rather than returning false.
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  const ok = a.length === b.length && require('crypto').timingSafeEqual(a, b);

  if (!ok) return res.status(401).json({ success: false, message: 'Unauthorized' });

  try {
    await ensureConnection();
    const { runDaily } = require('./src/services/reminderJobs');
    // ?dryRun=1 to check what it would do without sending anything.
    const result = await runDaily({ dryRun: req.query.dryRun === '1' });
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('[jobs] reminders failed:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

app.post('/api/jobs/reminders', runRemindersRoute);
app.get('/api/jobs/reminders', runRemindersRoute);

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    const mongoose = require('mongoose');
    const isDbConnected = mongoose.connection.readyState === 1;

    res.status(isDbConnected ? 200 : 503).json({
      status: isDbConnected ? 'healthy' : 'unhealthy',
      database: {
        status: isDbConnected ? 'connected' : 'disconnected',
        readyState: mongoose.connection.readyState
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Protected routes (authentication required for most)
app.use('/', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
}, allRoutes);

// Global error handler for Multer and other errors
app.use((error, req, res, next) => {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ 
      error: 'File too large', 
      message: `File size exceeds the maximum limit of ${process.env.UPLOAD_MAX_FILE_SIZE_MB || 5}MB` 
    });
  }
  
  if (error.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ 
      error: 'Too many files', 
      message: 'Number of files exceeds the maximum allowed. Maximum 10 banner images are allowed.' 
    });
  }
  
  if (error.name === 'MulterError') {
    return res.status(400).json({ 
      error: 'Upload error', 
      message: error.message 
    });
  }
  
  // Default error handler
  console.error(error);
  res.status(500).json({ 
    error: 'Internal server error', 
    message: error.message || 'Something went wrong' 
  });
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});

