require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { mongoose, ensureConnection } = require('./src/config/mongo');
const app = express();
const port = process.env.PORT || 4000;
const allRoutes = require('./src/routes/allRoutes');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Every session token is signed with JWT_SECRET, so a short one can be
// guessed offline from a single token. Said loudly at boot, without the
// value -- and only said: refusing to start would take a working site down
// over a setting that has to be changed with care (changing it signs
// everybody out).
if (IS_PRODUCTION && String(process.env.JWT_SECRET || '').length < 32) {
  console.warn(
    '[security] WARNING: JWT_SECRET is shorter than 32 characters. Session tokens signed with it can be forged by guessing it. ' +
      'Set a long random value (for example `openssl rand -hex 32`); everyone will have to sign in again.'
  );
}

// Vercel puts a proxy in front of this, so the client address arrives in
// X-Forwarded-For rather than on the socket. Without this, express reports
// the proxy's address as req.ip and every request in the world shares one
// rate-limit bucket. One hop, not `true`: trusting the whole chain would let
// a caller forge the header and pick their own bucket.
app.set('trust proxy', 1);

const gymfolioRoutes = require('./src/gymfolio/routes/gymfolioRoutes');
const paymentWebhookRoutes = require('./src/routes/paymentWebhookRoutes');
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
//   contentSecurityPolicy — helmet's default is written for a website (and its
//     form-action 'self' would stop the "confirm your email" button, whose
//     answer redirects to the gym's own site). This server returns JSON, files
//     and two plain pages (services/emailVerification.js: inline styles, one
//     form, no script), so it gets the narrowest policy those still render
//     under: nothing loads, nothing runs, nothing frames it. form-action is
//     left unset (it does not fall back to default-src). /uploads replaces
//     this with its own sandboxing policy below.
// ---------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false
  })
);

// ---------------------------------------------------------------------------
// Search engines
//
// This is an API: JSON for the gyms' websites and apps, nothing a person
// should land on from a search result. Crawlers are told so twice -- in
// robots.txt, and on every response for the ones that fetch a URL anyway.
// Done here rather than in vercel.json so it holds wherever this runs.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

// ---------------------------------------------------------------------------
// CORS
//
// Every gym on the platform has its own website on its own domain, and all
// of them talk to this one API. So the allowed origins are not a fixed list:
// an origin is allowed when it is one of the static ones below OR the domain
// of a registered gym (or a `<slug>.PLATFORM_ROOT_DOMAIN` subdomain). The
// lookup is the same cached one the tenant resolver uses.
//
// A developer's own machine (localhost:3000 the website, :3001 the panel) is
// allowed everywhere except production: there, any page served from
// localhost on a visitor's computer could otherwise call this API with that
// visitor's session, and an unset FRONTEND_ORIGIN must not quietly mean
// localhost. A localhost origin that really must reach production goes in
// EXTRA_CORS_ORIGINS, on purpose.
// ---------------------------------------------------------------------------
const LOCAL_ORIGINS = IS_PRODUCTION ? [] : ['http://localhost:3000', 'http://localhost:3001'];
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || LOCAL_ORIGINS[0] || '';
const GYMFOLIO_URL = process.env.GYMFOLIO_URL || LOCAL_ORIGINS[0] || '';
//
// EXTRA_CORS_ORIGINS is a comma-separated list for anything else that has to
// reach this API from a browser -- the member app's web build, which Expo
// serves from http://localhost:8081, is the usual one. The app on a phone
// sends no Origin header at all, so it never needs an entry here.
//
// PLATFORM_ADMIN_ORIGIN (the marketing site + panel) may be a list too, so
// the apex and the www host can both be named. Every entry is compared the
// way a browser writes an Origin: lowercase, no trailing slash -- an env
// value typed as "https://GymPilot.com/" used to match nothing.
function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}
function originList(value) {
  return String(value || '').split(',').map(normalizeOrigin);
}
const STATIC_ORIGINS = new Set(
  [
    FRONTEND_ORIGIN,
    GYMFOLIO_URL,
    ...originList(process.env.PLATFORM_ADMIN_ORIGIN),
    ...LOCAL_ORIGINS,
    ...originList(process.env.EXTRA_CORS_ORIGINS)
  ]
    .map(normalizeOrigin)
    .filter(Boolean)
);
const { isRegisteredOrigin } = require('./src/platform/middleware/resolveTenant');

app.use(cors({
  origin: async (origin, callback) => {
    // No Origin header: not a browser (curl, the desktop app, Stripe). CORS
    // does not apply, so there is nothing to refuse.
    if (!origin) return callback(null, true);
    if (STATIC_ORIGINS.has(normalizeOrigin(origin))) return callback(null, true);
    try {
      await ensureConnection();
      return callback(null, await isRegisteredOrigin(origin));
    } catch (error) {
      console.error('[cors] origin check failed:', error.message);
      return callback(null, false);
    }
  },
  credentials: true,
  // Downloads (report CSVs, invoice PDFs) name their file in this header;
  // without exposing it, script on another origin cannot read it and every
  // download is saved as "download".
  exposedHeaders: ['Content-Disposition'],
}));

// ---------------------------------------------------------------------------
// Body parsing
//
// Stripe signs the EXACT bytes it sent, so the webhook route must see the raw
// body -- once express.json() has parsed it, the signature can never verify.
// The route itself applies express.raw(); this skip is what leaves the stream
// unread for it.
//
// It used to name '/api/payment/webhook', the product-order webhook, which no
// longer exists. The gymfolio webhook that replaced it was NOT skipped, so it
// was handed a parsed object and constructEvent() rejected every event it ever
// received.
//
// The size limit is for what the API is actually sent as JSON or a form:
// records, settings, a page of text. Nothing larger travels that way --
// files are multipart and have their own limits (helper/upload.js), and a
// CSV import is a file. The old 50 MB applied to every route, signed in or
// not, so anyone could make the server parse 50 MB at a time.
// ---------------------------------------------------------------------------
const BODY_LIMIT = '1mb';
const STRIPE_WEBHOOK_PATH = '/api/gymfolio/payment/webhook';
// The platform's own webhook (GymsPilotPro charging gyms) needs the same
// untouched body as a gym's does.
const PLATFORM_WEBHOOK_PATH = '/api/platform/stripe/webhook';
// ...and so does the platform's Safepay webhook (gyms paying GymsPilotPro).
const PLATFORM_SAFEPAY_WEBHOOK_PATH = '/api/platform/safepay/webhook';
// Safepay signs the bytes it sent as well (src/routes/paymentWebhookRoutes.js).
const SAFEPAY_WEBHOOK_PREFIX = '/api/payments/safepay/webhook/';

app.use((req, res, next) => {
  const path = req.originalUrl.split('?')[0];
  // Both the legacy path and the per-gym one (/webhook/<slug>).
  if (path === STRIPE_WEBHOOK_PATH || path.startsWith(STRIPE_WEBHOOK_PATH + '/') || path === PLATFORM_WEBHOOK_PATH || path === PLATFORM_SAFEPAY_WEBHOOK_PATH || path.startsWith(SAFEPAY_WEBHOOK_PREFIX)) {
    next();
  } else {
    express.json({ limit: BODY_LIMIT })(req, res, next);
  }
});

// Also add urlencoded parser for form data
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

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
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Browsers will not show a PDF (a bank receipt, a member's document)
      // inside a sandbox. A .pdf is served as application/pdf with nosniff,
      // so it opens in the PDF viewer and never as a page.
      if (/\.pdf$/i.test(filePath)) return;
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    }
  })
);

// Middleware to ensure MongoDB connection for serverless environments
// ---------------------------------------------------------------------------
// Platform panel (super admin)
//
// Mounted BEFORE the tenant gate: it manages gyms, it does not belong to one.
// Its own routes carry their own authentication (platform tokens only).
// ---------------------------------------------------------------------------
const platformRoutes = require('./src/platform/routes/platformRoutes');
app.use('/api/platform', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({ success: false, message: 'Database connection failed. Please try again in a moment.' });
  }
}, platformRoutes);

// ---------------------------------------------------------------------------
// Phone app sign-in
//
// Also before the tenant gate, and for the same reason in reverse: a member
// opening the app has given us a username and nothing else, so which gym they
// belong to is exactly what this has to work out.
// ---------------------------------------------------------------------------
const mobileRoutes = require('./src/routes/mobileRoutes');
app.use('/api/mobile', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({ success: false, message: 'Database connection failed. Please try again in a moment.' });
  }
}, mobileRoutes);

// ---------------------------------------------------------------------------
// Linking a front-desk PC with a code from the admin panel
//
// Before the tenant gate for the same reason as the phone app: the desk
// typing the code does not know its gym yet -- the code tells it. The admin
// panel's half of these routes applies the gate's middleware itself
// (src/platform/routes/deskLinkRoutes.js).
// ---------------------------------------------------------------------------
const deskLinkRoutes = require('./src/platform/routes/deskLinkRoutes');
app.use('/api/desk-link', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({ success: false, message: 'Database connection failed. Please try again in a moment.' });
  }
}, deskLinkRoutes);

// ---------------------------------------------------------------------------
// Tenant gate
//
// Everything past this point runs for exactly one gym: the one whose website
// the request came from. resolveTenant works that out, opens that gym's
// database, and carries it through the request so every model call below
// lands in the right place. See src/platform/middleware/resolveTenant.js.
//
// A few paths are exempt because no gym can be known from the request
// itself -- they either need no gym, or learn it from their payload later:
//   /api/platform/*                     the panel above
//   /api/jobs/*                         the cron, which loops over every gym
//   /auth/google/callback               gym in the OAuth `state`
//   /api/gymfolio/payment/webhook       gym in the Stripe event metadata
//   /api/payments/safepay/webhook/<slug> gym in the path (Safepay's webhook)
// ---------------------------------------------------------------------------
const { resolveTenant } = require('./src/platform/middleware/resolveTenant');

const TENANT_EXEMPT_EXACT = new Set(['/', '/health', '/robots.txt', '/auth/google/callback', '/api/gymfolio/payment/webhook']);
const TENANT_EXEMPT_PREFIXES = ['/uploads/', '/api/platform', '/api/jobs', '/api/gymfolio/payment/webhook/', SAFEPAY_WEBHOOK_PREFIX];

function isTenantExempt(path) {
  const clean = path.split('?')[0];
  if (TENANT_EXEMPT_EXACT.has(clean)) return true;
  return TENANT_EXEMPT_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

app.use(async (req, res, next) => {
  if (isTenantExempt(req.path)) return next();
  try {
    await ensureConnection();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    return res.status(503).json({
      success: false,
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
  return resolveTenant(req, res, next);
});

// GET /api/tenant -- which gym this domain is serving. Public: the website
// uses it to show a clear message when a domain is not linked to any gym.
app.get('/api/tenant', (req, res) => {
  const gym = req.tenant;
  return res.json({
    success: true,
    data: {
      slug: gym.slug,
      name: gym.name,
      status: gym.status,
      subscription_status: gym.subscription ? gym.subscription.status : null,
      timezone: gym.locale ? gym.locale.timezone : null,
      currency: gym.locale ? gym.locale.currency : null,
      matched_host: req.tenantHost || null,
      source: req.tenantSource
    }
  });
});

// The gym's own subscription to GymsPilotPro: what it is on, and the Stripe
// checkout / billing portal to pay for it. Past the tenant gate on purpose --
// the gym asking is the one whose site the request came from.
const billingRoutes = require('./src/platform/routes/billingRoutes');
app.use('/api/billing', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({ success: false, message: 'Database connection failed. Please try again in a moment.' });
  }
}, billingRoutes);

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

// Webhooks from payment gateways other than Stripe (Safepay), one address
// per gym: past the tenant gate on purpose, the gym is read from the path.
app.use('/api/payments', paymentWebhookRoutes);

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
      message: 'GymsPilotPro API',
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
      message: 'GymsPilotPro API',
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
  // The time budget counts from here: connecting and the platform steps
  // below use the same function time limit the gyms do.
  const startedAt = Date.now();
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
    const { scheduleActiveGyms, dailyJobPace, rollSubscriptionStatuses, sendOwnerBillingNotices } = require('./src/platform/jobs');
    const { closeStaleVisits } = require('./src/attendance/services/staleVisits');
    // ?dryRun=1 to check what it would do without sending anything.
    const dryRun = req.query.dryRun === '1';
    // ?gym=<slug> runs that one gym only -- a catch-up for a gym the budget
    // left over, or one whose run failed. The platform-wide steps are not
    // repeated for it: they have already run today and are not that gym's.
    const gymSlug = typeof req.query.gym === 'string' ? req.query.gym.toLowerCase().trim() : '';

    // Platform first: a gym whose subscription lapsed today is skipped by the
    // per-gym loop below rather than emailed one last time.
    const subscriptions = gymSlug ? { skipped: 'single gym run' } : await rollSubscriptionStatuses({ dryRun });
    // Then the owners: trial ending, payment overdue, access ended -- each
    // notice once, after the statuses above have settled.
    const notices = gymSlug ? { skipped: 'single gym run' } : await sendOwnerBillingNotices({ dryRun });
    const signups = gymSlug ? { skipped: 'single gym run' } : await require('./src/platform/jobs').recoverStuckSignups({ dryRun });
    // Then every gym, each inside its own database, a few side by side (see
    // dailyJobPace). New gyms stop being started once the time budget is
    // used, so the function answers instead of being cut off; the gyms left
    // over are listed under schedule.deferred and go first tomorrow. Visits
    // nobody checked out of are closed first, on their own: a failure there
    // must not cost the gym its reminders, and a failed email run must not
    // leave members "inside" for ever.
    const { concurrency, budgetMs } = dailyJobPace();
    const { gyms, schedule } = await scheduleActiveGyms(
      async () => {
        let staleVisits;
        try {
          staleVisits = await closeStaleVisits({ dryRun });
        } catch (error) {
          staleVisits = { error: error.message };
        }
        return { staleVisits, ...(await runDaily({ dryRun })) };
      },
      { job: 'daily', record: !dryRun, slug: gymSlug || null, concurrency, budgetMs, startedAt }
    );

    if (gymSlug && !Object.keys(gyms).length) {
      return res.status(404).json({ success: false, message: `No active gym "${gymSlug}".` });
    }
    // Then the platform pass after the gyms: owners reminded to pay
    // GymsPilotPro before, on and after their due date -- each reminder once
    // per period, after the lifecycle emails above, so a gym that went
    // overdue this morning gets one email, not two. A failure here is
    // reported, never the whole run's.
    const payReminders = gymSlug
      ? { skipped: 'single gym run' }
      : await require('./src/platform/services/ownerPayReminders')
          .sendOwnerPayReminders({ dryRun })
          .catch((error) => {
            console.error('[jobs] payment reminders failed:', error);
            return { error: error.message };
          });
    if (schedule.deferred.length) {
      console.warn(`[jobs] time budget used; ${schedule.deferred.length} gym(s) left for the next run: ${schedule.deferred.join(', ')}`);
    }

    return res.json({ success: true, dryRun, subscriptions, notices, signups, gyms, schedule, payReminders });
  } catch (error) {
    console.error('[jobs] reminders failed:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

app.post('/api/jobs/reminders', runRemindersRoute);
app.get('/api/jobs/reminders', runRemindersRoute);

// Health check endpoint
//
// On a serverless instance that has just started, the database connection is
// still being opened when the first request arrives -- and a monitor's check
// is often that first request. Answering from the connection state alone
// said "unhealthy" on every cold start, so a monitor flapped all day. This
// waits for the connection (opening it if nobody has yet), but only briefly:
// a database that is really down still gets its 503, a few seconds later.
const HEALTH_CONNECT_TIMEOUT_MS = 5000;

function connectedWithin(ms) {
  if (mongoose.connection.readyState === 1) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    ensureConnection()
      .then(() => resolve(mongoose.connection.readyState === 1), () => resolve(false))
      .finally(() => clearTimeout(timer));
  });
}

app.get('/health', async (req, res) => {
  try {
    const isDbConnected = await connectedWithin(HEALTH_CONNECT_TIMEOUT_MS);

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

// Nothing above answered: no such endpoint. Said in the shape every other
// refusal has, where Express's own answer is an HTML page ("Cannot GET
// /...") that an app expecting JSON cannot read.
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found', message: 'There is nothing at this address.' });
});

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

  // Our own upload filters ("Only image files are allowed", "Only .csv files
  // are accepted") are the caller's mistake, not the server's.
  if (error && /^Only .+ (files|images) (are|is) (allowed|accepted)/i.test(String(error.message))) {
    return res.status(400).json({ success: false, error: 'Upload error', message: error.message });
  }
  
  // The body parsers' refusals are the caller's mistake too: a body that is
  // not JSON, or one over the size limit. Answering 500 made both look like a
  // server fault and hid what to fix.
  if (error && error.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid JSON', message: 'The request body is not valid JSON.' });
  }
  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Payload too large', message: 'The request body is too large.' });
  }

  // So is a value the database cannot read as what the field holds -- nearly
  // always a malformed id in the address ("/gym-classes/not-an-id").
  if (error && error.name === 'CastError') {
    return res.status(400).json({ success: false, error: 'Invalid value', message: 'That id or value is not valid.' });
  }

  // Default error handler. Only something nobody wrote a message for reaches
  // here, so the message is whatever the library that threw it says -- a
  // driver or validation string that can name a field, a collection or a
  // host. It goes to the log, where it is useful, and the caller is told the
  // same thing every time.
  console.error(error);
  res.status(500).json({
    error: 'Internal server error',
    message: 'Something went wrong'
  });
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});

