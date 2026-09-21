// src/controller/uploadController.js
//
// Large files straight from the browser to Vercel Blob.
//
// Every other upload travels through this API: multer reads the file and
// helper/blobUpload.js put()s it in the store. On Vercel a function's request
// body stops at 4.5 MB, so that path is capped at 4 MB there (see
// helper/upload.js) -- too small for a homepage video or a full-size photo.
// Files over the API's limit go from the browser to the store instead, with a
// short-lived client token handed out here:
//
//   GET  /api/uploads/capabilities  whether this server can hand out tokens,
//                                   and each kind's API and direct ceilings,
//                                   so the admin pages pick the path up front
//   POST /api/uploads/blob          the handleUpload() exchange from
//                                   @vercel/blob/client. The browser names a
//                                   kind, a content type and a size; the
//                                   token it gets back is good for ONE path,
//                                   chosen here under this gym's
//                                   `<slug>/<folder>/`, and for that kind's
//                                   types and ceiling only. Whatever path the
//                                   browser proposed is cut down to a file
//                                   name.
//
// The page then saves the resulting URL where it would have saved the file
// (hero slides and testimonials take it as `uploadedImageUrl`; homepage
// sections store URLs already).
//
// Vercel calls the same route back when an upload completes
// (`blob.upload-completed`). That call carries no user and no website, only
// Vercel's signature, which handleUpload() verifies; nothing needs doing
// with it, so it is acknowledged and otherwise ignored. The `?tenant=` on
// its URL is only there to get it past the tenant gate in index.js.

const { handleUpload } = require('@vercel/blob/client');
const auth = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const {
  EXTENSION_FOR_MIME,
  MAX_FILE_BYTES,
  MAX_VIDEO_FILE_BYTES,
  tenantUploadFolder,
} = require('../helper/upload');
const { folderFor, MAX_VIDEO_SIZE } = require('../helper/blobUpload');

const GENERATE_TOKEN = 'blob.generate-client-token';
const UPLOAD_COMPLETED = 'blob.upload-completed';

const MB = 1024 * 1024;

// No SVG and nothing exotic: these are served back to every visitor of the
// gym's site. (The API path takes a few more video types; a browser plays
// these two everywhere.)
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/webm'];

// The hero-image ceiling helper/upload.js applies off Vercel; videos keep the
// store's own video ceiling (UPLOAD_MAX_VIDEO_SIZE_MB, 100 MB by default).
const MAX_DIRECT_IMAGE_BYTES = 20 * MB;
const MAX_DIRECT_VIDEO_BYTES = MAX_VIDEO_SIZE;

// What may be uploaded direct, by kind: the permission tab that must be held
// at 'manage', the store folder (the same one the API path uses for that
// kind), the allowed types, the direct ceiling, and the ceiling of the
// ordinary API route for the same file -- below which the page keeps using it.
const KINDS = {
  'homepage-image': {
    tab: 'homepage',
    folder: 'home-sections',
    contentTypes: IMAGE_TYPES,
    maxBytes: MAX_DIRECT_IMAGE_BYTES,
    apiMaxBytes: MAX_FILE_BYTES,
  },
  'homepage-video': {
    tab: 'homepage',
    folder: 'home-videos',
    contentTypes: VIDEO_TYPES,
    maxBytes: MAX_DIRECT_VIDEO_BYTES,
    apiMaxBytes: MAX_VIDEO_FILE_BYTES,
  },
  'hero-slide': {
    tab: 'hero-slides',
    folder: 'hero-slides',
    contentTypes: IMAGE_TYPES,
    maxBytes: MAX_DIRECT_IMAGE_BYTES,
    apiMaxBytes: MAX_FILE_BYTES,
  },
  testimonial: {
    tab: 'testimonials',
    folder: 'testimonials',
    contentTypes: IMAGE_TYPES,
    maxBytes: MAX_DIRECT_IMAGE_BYTES,
    apiMaxBytes: MAX_FILE_BYTES,
  },
};

// One permission gate per kind, built at startup so a mistyped tab fails
// there (see requirePermission).
const GATES = Object.fromEntries(
  Object.entries(KINDS).map(([kind, rule]) => [kind, requirePermission(rule.tab, 'manage')])
);

const NOT_CONFIGURED = {
  success: false,
  code: 'BLOB_NOT_CONFIGURED',
  message: 'Large uploads need file storage (Vercel Blob), which is not configured on this server.',
};

function blobConfigured() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

function refusal(status, code, message) {
  return { error: { status, code, message } };
}

// The browser's own description of its file, from handleUpload's
// `clientPayload`: a JSON object, or nothing usable.
function readClientPayload(raw) {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Only the last segment of whatever path the browser proposed, without its
// extension, reduced to letters, digits, '-' and '_'. The extension comes
// from the checked content type instead.
function safeBaseName(proposed) {
  const last = String(proposed || '').split(/[\\/]/).pop() || '';
  const base = last
    .replace(/\.[^.]*$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return base || 'file';
}

function describeTypes(types) {
  return types.map((type) => type.split('/')[1].toUpperCase().replace('JPEG', 'JPG')).join(', ');
}

/**
 * Whether a direct upload may go ahead, and where it goes. Pure -- the route
 * supplies the gym's slug and the browser's claim about its file.
 *
 * @param {{kind?: string, contentType?: string, size?: number, filename?: string}} claim
 * @param {string} slug  the gym's slug ('' outside a gym)
 * @returns {{error: {status: number, code: string, message: string}} |
 *           {kind: string, rule: object, contentType: string, prefix: string, pathname: string}}
 */
function planDirectUpload(claim = {}, slug = '') {
  const kind = String(claim.kind || '');
  const rule = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
  if (!rule) return refusal(400, 'UPLOAD_KIND_UNKNOWN', 'This kind of upload is not supported.');

  const contentType = String(claim.contentType || '').toLowerCase();
  if (!rule.contentTypes.includes(contentType)) {
    return refusal(400, 'UPLOAD_TYPE_NOT_ALLOWED', `Only ${describeTypes(rule.contentTypes)} files can be uploaded here.`);
  }

  const size = Number(claim.size);
  if (!Number.isFinite(size) || size <= 0) {
    return refusal(400, 'UPLOAD_SIZE_MISSING', 'The file is empty.');
  }
  if (size > rule.maxBytes) {
    return refusal(413, 'FILE_TOO_LARGE', `Files over ${Math.round(rule.maxBytes / MB)} MB can't be uploaded — compress the file and try again.`);
  }

  const prefix = `${folderFor(slug, rule.folder)}/`;
  const rand = Math.round(Math.random() * 1e9);
  const pathname = `${prefix}${Date.now()}-${rand}-${safeBaseName(claim.filename)}${EXTENSION_FOR_MIME[contentType]}`;
  return { kind, rule, contentType, prefix, pathname };
}

/**
 * What the client token allows, for handleUpload's onBeforeGenerateToken.
 * Throws (and so issues no token) for any path but the one planned.
 */
function tokenOptionsFor(plan, pathname, context = {}) {
  if (pathname !== plan.pathname || !pathname.startsWith(plan.prefix)) {
    throw new Error('Upload path does not match the one issued');
  }
  return {
    allowedContentTypes: [plan.contentType],
    maximumSizeInBytes: plan.rule.maxBytes,
    // Rides along to the completion callback. Ids only -- never the
    // browser's payload, which is not ours to vouch for.
    tokenPayload: JSON.stringify({ kind: plan.kind, gym: context.slug || null, user: context.userId || null }),
  };
}

// Where Vercel posts `blob.upload-completed`: this same route, on this API,
// with the gym named so the tenant gate lets it through.
function callbackUrlFor(req, slug) {
  const base = `${req.protocol}://${req.get('host')}/api/uploads/blob`;
  return slug ? `${base}?tenant=${encodeURIComponent(slug)}` : base;
}

// Vercel's completion callback is checked by signature in handleUpload(),
// never by a user token; nothing in it needs acting on.
async function ignoreCompletion() {}

async function refuseToken() {
  throw new Error('Tokens are issued with a signed-in request only');
}

/**
 * POST /api/uploads/blob gate: a token request needs a signed-in account
 * holding 'manage' on the tab its kind belongs to. Vercel's completion
 * callback passes straight through to handleUpload(), which verifies it.
 */
function authorizeBlobUpload(req, res, next) {
  const body = req.body || {};
  if (body.type === UPLOAD_COMPLETED) return next();

  return auth(req, res, (error) => {
    if (error) return next(error);
    const { kind } = readClientPayload(body.payload && body.payload.clientPayload);
    const gate = Object.prototype.hasOwnProperty.call(GATES, kind) ? GATES[kind] : null;
    if (!gate) {
      return res.status(400).json({ success: false, code: 'UPLOAD_KIND_UNKNOWN', message: 'This kind of upload is not supported.' });
    }
    return gate(req, res, next);
  });
}

// POST /api/uploads/blob
async function handleBlobUpload(req, res) {
  if (!blobConfigured()) return res.status(409).json(NOT_CONFIGURED);

  const body = req.body || {};

  if (body.type === UPLOAD_COMPLETED) {
    try {
      const result = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: refuseToken,
        onUploadCompleted: ignoreCompletion,
      });
      return res.status(200).json(result);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  if (body.type !== GENERATE_TOKEN) {
    return res.status(400).json({ success: false, message: 'Unknown upload request' });
  }

  const payload = body.payload || {};
  const slug = tenantUploadFolder(req);
  const claim = readClientPayload(payload.clientPayload);
  const plan = planDirectUpload({ ...claim, filename: payload.pathname }, slug);
  if (plan.error) {
    const { status, code, message } = plan.error;
    return res.status(status).json({ success: false, code, message });
  }

  try {
    // The event is rebuilt rather than passed on: the path and the callback
    // address are ours to choose, not the browser's.
    const result = await handleUpload({
      body: {
        type: GENERATE_TOKEN,
        payload: {
          pathname: plan.pathname,
          callbackUrl: callbackUrlFor(req, slug),
          clientPayload: null,
          multipart: payload.multipart === true,
        },
      },
      request: req,
      onBeforeGenerateToken: async (pathname) =>
        tokenOptionsFor(plan, pathname, { slug, userId: req.user && req.user.id }),
      onUploadCompleted: ignoreCompletion,
    });
    // `pathname` is where the token lets the browser put the file.
    return res.status(200).json({ ...result, pathname: plan.pathname });
  } catch (error) {
    console.error('[uploads] client token failed:', error);
    return res.status(500).json({ success: false, message: 'Could not start the upload. Please try again.' });
  }
}

// GET /api/uploads/capabilities
function capabilities(req, res) {
  const kinds = {};
  for (const [kind, rule] of Object.entries(KINDS)) {
    kinds[kind] = {
      apiMaxBytes: rule.apiMaxBytes,
      directMaxBytes: rule.maxBytes,
      contentTypes: rule.contentTypes,
    };
  }
  return res.status(200).json({ success: true, data: { direct: blobConfigured(), kinds } });
}

module.exports = {
  authorizeBlobUpload,
  handleBlobUpload,
  capabilities,
  planDirectUpload,
  tokenOptionsFor,
  callbackUrlFor,
  safeBaseName,
  KINDS,
};
