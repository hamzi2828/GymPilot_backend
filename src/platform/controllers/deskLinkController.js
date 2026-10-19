// src/platform/controllers/deskLinkController.js
//
// Linking a front-desk PC to a gym with a one-time code, instead of typing
// a server address, a gym domain and a password into it.
//
//   1. On the website's admin panel (Desk app page) a signed-in account that
//      may use the front-desk app asks for a code: `createCode`.
//   2. Someone types that code into the Windows app, which sends it to
//      `redeem` -- with no gym named, because the app does not know its gym
//      yet. The code says which gym and which account.
//   3. `redeem` answers with the gym's web address (the app saves it as its
//      gymDomain) and a desk session issued exactly as /api/desktop/login
//      issues one, so the desk is linked AND signed in, as that account.
//
// Codes are 8 characters from a 32-letter alphabet with nothing that reads
// as something else (no 0/O, no 1/I): 40 random bits, good for 15 minutes
// and one use. Only a keyed hash is stored, in the platform database.
//
// The same page lists the desks signed in to the gym and can sign one out
// ("Unlink"): that is the existing desk token being revoked, which stops
// the PC on its very next request (desktopAuth).

const crypto = require('crypto');
const mongoose = require('mongoose');

const Gym = require('../models/gymModel');
const DeskLinkCode = require('../models/deskLinkCodeModel');
const PlatformAuditLog = require('../models/platformAuditLogModel');
const { runWithTenant, primaryHost, subdomainHostFor } = require('../tenantContext');

const User = require('../../models/user');
const AdminAuditLog = require('../../models/adminAuditLogModel');
const { can, ADMIN_SLUG } = require('../../services/roleService');
const DesktopToken = require('../../attendance/models/desktopTokenModel');
const AttendanceLog = require('../../attendance/models/attendanceLogModel');
const { deviceContext, isKioskToken } = require('../../attendance/middleware/desktopAuth');
const { openDeskSession } = require('../../attendance/controller/desktopAppController');

const CODE_MINUTES = 15;
// Codes one account may have waiting at once. A fourth replaces the oldest,
// so pressing the button again never locks anyone out.
const MAX_ACTIVE_CODES = 3;

// 32 characters, so one random byte's low five bits pick one with no bias.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const CODE_PATTERN = /^[2-9A-HJ-NP-Z]{8}$/;

// The one sentence the app and the panel use for an account without the
// front-desk grant, naming the switch the way the Staff page labels it.
const NOT_ALLOWED =
  'This account is not allowed to use the front-desk app. An administrator can switch on ' +
  '"Can sign in to the attendance app" for it on the Staff page.';

// ---------------------------------------------------------------------------
// The code itself
// ---------------------------------------------------------------------------

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let raw = '';
  for (const byte of bytes) raw += ALPHABET[byte & 31];
  return raw;
}

/** "K7QP3M9X" -> "K7QP-3M9X": how it is shown and how people read it out. */
function formatCode(raw) {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * What was typed, as it was issued: upper case, with the spaces and dashes
 * people add taken out. Null when it cannot be a code at all.
 */
function normalizeCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[\s-]/g, '');
  return CODE_PATTERN.test(raw) ? raw : null;
}

function codeSecret() {
  const value = process.env.DESK_LINK_SECRET || process.env.JWT_SECRET;
  if (!value) throw new Error('Cannot hash desk link codes: set DESK_LINK_SECRET (or JWT_SECRET)');
  return value;
}

// Keyed, not a bare SHA-256: 40 bits is a search a laptop finishes in
// minutes, so a copy of the database alone must not be enough to read the
// codes waiting in it.
function hashCode(raw) {
  return crypto.createHmac('sha256', codeSecret()).update(`desk-link|${raw}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The address a desk names its gym by (X-Tenant-Host), or null. */
function gymDomainFor(gym) {
  return primaryHost(gym) || subdomainHostFor(gym && gym.slug) || null;
}

/** This API's own address, for the app to keep using. */
function apiBaseUrl(req) {
  const fixed = String(process.env.API_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (fixed) return `${fixed}/`;
  const host = req && typeof req.get === 'function' ? req.get('host') : '';
  return host ? `${req.protocol || 'https'}://${host}/` : '';
}

function clientIp(req) {
  return String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || '');
}

function displayName(account) {
  if (!account) return '';
  return [account.firstName, account.lastName].filter(Boolean).join(' ').trim() || account.email || account.username || '';
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/**
 * What the signed-in account may do here, read live (never from the token):
 *   canLink  -- ask for a code: an administrator, or an account holding the
 *               front-desk grant, exactly who could sign the app in anyway.
 *   seesAll  -- see and unlink every desk of the gym, not only its own: an
 *               administrator or a role with attendance at manage.
 */
async function accessOf(req) {
  const account = await User.findById(req.user && req.user.id)
    .select('firstName lastName email username role isActive allowAttendanceApp')
    .lean();
  if (!account) return { refusal: { status: 401, message: 'Account no longer exists' } };
  if (account.isActive === false) return { refusal: { status: 403, message: 'Account is disabled' } };

  const isAdmin = account.role === ADMIN_SLUG;
  const seesAll = isAdmin || (await can(account.role, 'attendance', 'manage'));
  return { account, isAdmin, canLink: isAdmin || !!account.allowAttendanceApp, seesAll };
}

function refuse(res, refusal) {
  return res.status(refusal.status).json({ success: false, code: refusal.code, message: refusal.message });
}

function auditInGym(req, account, body, status = 200) {
  AdminAuditLog.record({
    actorId: account._id,
    actorEmail: account.email || '',
    actorRole: account.role || '',
    method: req.method,
    path: req.originalUrl.split('?')[0],
    tab: 'attendance',
    status,
    body,
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 200)
  });
}

function deskRow(token, people, viewerId) {
  const owner = people.get(String(token.userId));
  return {
    id: String(token._id),
    device: token.deviceLabel || '',
    kind: isKioskToken(token) ? 'kiosk' : 'desk',
    account: displayName(owner) || 'A removed account',
    mine: sameId(token.userId, viewerId),
    signed_in_at: token.createdAt || null,
    last_seen_at: token.lastUsedAt || null,
    expires_at: token.expiresAt || null
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// GET /api/desk-link   (staff session, for the gym the site belongs to)
//
// What the Desk app page needs on opening: may this account ask for a code,
// and which desks are signed in right now.
async function overview(req, res) {
  try {
    const access = await accessOf(req);
    if (access.refusal) return refuse(res, access.refusal);
    const { account, isAdmin, canLink, seesAll } = access;

    const filter = { revokedAt: null, expiresAt: { $gt: new Date() } };
    if (!seesAll) filter.userId = account._id;
    const tokens = await DesktopToken.find(filter).sort({ lastUsedAt: -1, createdAt: -1 }).limit(200).lean();

    const ids = [...new Set(tokens.map((t) => String(t.userId)))];
    const owners = ids.length
      ? await User.find({ _id: { $in: ids } }).select('firstName lastName email username').lean()
      : [];
    const people = new Map(owners.map((o) => [String(o._id), o]));

    return res.json({
      success: true,
      data: {
        can_link: canLink,
        // An administrator without the grant can switch it on with their
        // first code, once they confirm it (createCode's 409
        // DESK_PERMISSION_REQUIRED); the page can say so before they press
        // the button.
        grants_access_on_link: isAdmin && !account.allowAttendanceApp,
        not_allowed_reason: canLink ? null : NOT_ALLOWED,
        code_minutes: CODE_MINUTES,
        scope: seesAll ? 'all' : 'own',
        desks: tokens.map((t) => deskRow(t, people, account._id))
      }
    });
  } catch (error) {
    console.error('[desk-link] overview failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load the desks.' });
  }
}

// POST /api/desk-link/codes   (staff session)
//
// A fresh code for the signed-in account at this gym. The code is in this
// answer and nowhere else -- only its hash is kept.
async function createCode(req, res) {
  try {
    const access = await accessOf(req);
    if (access.refusal) return refuse(res, access.refusal);
    const { account, isAdmin, canLink } = access;
    const gym = req.tenant;

    if (!canLink) {
      return res.status(403).json({ success: false, code: 'DESK_APP_NOT_ALLOWED', message: NOT_ALLOWED });
    }

    // A desk names its gym by web address; a gym with none could not be
    // found by the desk it was linked to.
    const domain = gymDomainFor(gym);
    if (!domain) {
      return res.status(409).json({
        success: false,
        code: 'GYM_HAS_NO_ADDRESS',
        message: 'This gym has no website address yet, so a desk cannot find it. Contact GymsPilotPro support.'
      });
    }

    // An administrator without the front-desk grant may switch it on for
    // themselves here (they could on the Staff page anyway) -- but only when
    // they say so: the grant lets the account run a front-desk PC, so the page
    // asks first (409 DESK_PERMISSION_REQUIRED) and sends the request again
    // with `grant_desk_access: true`. Recorded, and said on screen.
    let grantedAppAccess = false;
    if (isAdmin && !account.allowAttendanceApp) {
      if (!(req.body && req.body.grant_desk_access === true)) {
        return res.status(409).json({
          success: false,
          code: 'DESK_PERMISSION_REQUIRED',
          message: 'Your account is not allowed to run the desk app yet.'
        });
      }
      await User.updateOne({ _id: account._id }, { $set: { allowAttendanceApp: true } });
      grantedAppAccess = true;
      PlatformAuditLog.record({
        action: 'desk_link.desk_access_granted',
        actorEmail: account.email || account.username || '',
        gymId: gym._id,
        gymSlug: gym.slug,
        meta: { userId: String(account._id) },
        ip: clientIp(req)
      });
      auditInGym(req, account, { action: 'Desk app access switched on for own account', allowAttendanceApp: true });
    }

    // Keep at most MAX_ACTIVE_CODES waiting per account: the newest ones.
    const now = new Date();
    const waiting = await DeskLinkCode.find({
      gymId: gym._id,
      userId: account._id,
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: now }
    })
      .sort({ createdAt: -1 })
      .select('_id')
      .lean();
    const pushedOut = waiting.slice(MAX_ACTIVE_CODES - 1).map((c) => c._id);
    if (pushedOut.length) {
      await DeskLinkCode.updateMany({ _id: { $in: pushedOut }, usedAt: null }, { $set: { revokedAt: now } });
    }

    const expiresAt = new Date(now.getTime() + CODE_MINUTES * 60 * 1000);
    let raw = null;
    // A clash in 2^40 is next to impossible, but the unique index would
    // turn one into a 500; draw again instead.
    for (let attempt = 0; attempt < 3 && !raw; attempt += 1) {
      const candidate = generateCode();
      try {
        await DeskLinkCode.create({
          codeHash: hashCode(candidate),
          gymId: gym._id,
          gymSlug: gym.slug,
          userId: account._id,
          userEmail: account.email || account.username || '',
          expiresAt
        });
        raw = candidate;
      } catch (error) {
        if (!(error && error.code === 11000)) throw error;
      }
    }
    if (!raw) throw new Error('could not draw a unique desk link code');

    PlatformAuditLog.record({
      action: 'desk_link.code_created',
      actorEmail: account.email || account.username || '',
      gymId: gym._id,
      gymSlug: gym.slug,
      meta: { userId: String(account._id), grantedAppAccess, replaced: pushedOut.length },
      ip: clientIp(req)
    });
    auditInGym(req, account, { action: 'Desk link code created', minutes: CODE_MINUTES, grantedAppAccess }, 201);

    return res.status(201).json({
      success: true,
      data: {
        code: formatCode(raw),
        expires_at: expiresAt.toISOString(),
        minutes: CODE_MINUTES,
        granted_app_access: grantedAppAccess
      }
    });
  } catch (error) {
    console.error('[desk-link] create failed:', error);
    return res.status(500).json({ success: false, message: 'Could not make a link code. Try again.' });
  }
}

// POST /api/desk-link/desks/:id/unlink   (staff session)
//
// Signs one desk out for good: its token is revoked, and the PC drops to
// the sign-in window on its next request. An account sees and unlinks its
// own desks; an administrator (or attendance at manage) any of the gym's.
async function unlink(req, res) {
  try {
    const access = await accessOf(req);
    if (access.refusal) return refuse(res, access.refusal);
    const { account, seesAll } = access;

    const id = String(req.params.id || '');
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: 'That desk is not signed in.' });
    }

    const filter = { _id: id, revokedAt: null };
    if (!seesAll) filter.userId = account._id;
    const token = await DesktopToken.findOneAndUpdate(filter, { $set: { revokedAt: new Date() } }, { new: true }).lean();
    if (!token) return res.status(404).json({ success: false, message: 'That desk is not signed in.' });

    AttendanceLog.record({
      event: 'logout',
      userId: token.userId,
      success: true,
      message: `Unlinked from the admin panel by ${displayName(account) || 'an administrator'}`,
      device: token.deviceLabel || '',
      clientApp: token.clientApp || '',
      ip: clientIp(req),
      meta: { via: 'admin_unlink', by: String(account._id) }
    });
    auditInGym(req, account, { action: 'Desk unlinked', device: token.deviceLabel || '' });

    return res.json({ success: true, message: 'Desk unlinked. It will ask to sign in again.' });
  } catch (error) {
    console.error('[desk-link] unlink failed:', error);
    return res.status(500).json({ success: false, message: 'Could not unlink that desk.' });
  }
}

// Why a code that matched no claim cannot be used, from its stored record.
function spentReason(record) {
  if (!record) {
    return { status: 404, code: 'CODE_NOT_FOUND', message: 'That code is not right. Check it, or get a new one in your admin panel.' };
  }
  if (record.usedAt) {
    return { status: 409, code: 'CODE_USED', message: 'Code already used — get a new one in your admin panel.' };
  }
  if (record.revokedAt) {
    return {
      status: 410,
      code: 'CODE_EXPIRED',
      message: 'That code was replaced by a newer one — use the newest code from your admin panel.'
    };
  }
  return { status: 410, code: 'CODE_EXPIRED', message: 'That code has expired — get a new one in your admin panel.' };
}

// POST /api/desk-link/redeem   { code, device_name? }   -- no gym, no session
//
// The Windows app's "Link with code". Rate-limited per address (routes),
// since this is the one place a code could be guessed.
async function redeem(req, res) {
  const body = req.body || {};
  // device_name is the field this endpoint documents; the app's own client
  // sends device_label with every request. Either names the PC.
  if (!body.device_label && body.device_name) body.device_label = body.device_name;
  const device = deviceContext(req);
  const ip = clientIp(req);

  try {
    const raw = normalizeCode(body.code);
    if (!raw) {
      return res.status(400).json({
        success: false,
        code: 'CODE_INVALID',
        message: 'That does not look like a link code. It is 8 letters and numbers, like K7QP-3M9X.'
      });
    }

    const now = new Date();
    const codeHash = hashCode(raw);

    // The claim and the check are one write: two desks typing the same
    // code at the same moment cannot both win it.
    const claimed = await DeskLinkCode.findOneAndUpdate(
      { codeHash, usedAt: null, revokedAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now, usedIp: ip, usedDevice: device.deviceLabel } },
      { new: true }
    ).lean();

    if (!claimed) {
      const record = await DeskLinkCode.findOne({ codeHash }).lean();
      const reason = spentReason(record);
      // Only codes that exist are worth a line: a run of wrong guesses is
      // the limiter's business, not the trail's.
      if (record) {
        PlatformAuditLog.record({
          action: 'desk_link.refused',
          actorEmail: record.userEmail || '',
          gymId: record.gymId,
          gymSlug: record.gymSlug || '',
          meta: { reason: reason.code, device: device.deviceLabel },
          ip
        });
      }
      return refuse(res, reason);
    }

    const refusedAfterClaim = (refusal, why) => {
      PlatformAuditLog.record({
        action: 'desk_link.refused',
        actorEmail: claimed.userEmail || '',
        gymId: claimed.gymId,
        gymSlug: claimed.gymSlug || '',
        meta: { reason: why, device: device.deviceLabel },
        ip
      });
      return refuse(res, refusal);
    };

    // Read fresh, not from the tenant cache: a gym suspended a minute ago
    // must not get a desk signed in.
    const gym = await Gym.findByIdWithUri(claimed.gymId);
    const blocked = Gym.accessBlock(gym);
    if (blocked) return refusedAfterClaim(blocked, blocked.code);

    const domain = gymDomainFor(gym);
    if (!domain) {
      return refusedAfterClaim(
        { status: 409, code: 'GYM_HAS_NO_ADDRESS', message: 'This gym has no website address yet. Contact GymsPilotPro support.' },
        'GYM_HAS_NO_ADDRESS'
      );
    }

    // From here on everything reads and writes the gym's own database.
    const outcome = await runWithTenant(gym, async () => {
      const user = await User.findById(claimed.userId);
      if (!user || user.isActive === false) {
        return {
          refusal: {
            status: 403,
            code: 'ACCOUNT_DISABLED',
            message: 'The account that made this code has been switched off. Get a new code from an active account.'
          }
        };
      }
      // The grant is re-read now: switched off since the code was made
      // means no desk session, as it would for a password sign-in.
      if (!user.allowAttendanceApp) {
        return { refusal: { status: 403, code: 'DESK_APP_NOT_ALLOWED', message: NOT_ALLOWED } };
      }
      const session = await openDeskSession(user, device, { meta: { via: 'link_code' } });
      return { session, userName: displayName(user) };
    });

    if (outcome.refusal) return refusedAfterClaim(outcome.refusal, outcome.refusal.code);

    PlatformAuditLog.record({
      action: 'desk_link.redeemed',
      actorEmail: claimed.userEmail || '',
      gymId: gym._id,
      gymSlug: gym.slug,
      meta: { userId: String(claimed.userId), device: device.deviceLabel, clientApp: device.clientApp },
      ip
    });

    return res.json({
      success: true,
      gym: { name: gym.name, slug: gym.slug, domain },
      api_base_url: apiBaseUrl(req),
      session: outcome.session
    });
  } catch (error) {
    console.error('[desk-link] redeem failed:', error);
    return res.status(500).json({ success: false, message: 'Could not link this desk. Try again in a moment.' });
  }
}

module.exports = {
  overview,
  createCode,
  unlink,
  redeem,
  // For the tests.
  generateCode,
  formatCode,
  normalizeCode,
  hashCode,
  CODE_MINUTES,
  MAX_ACTIVE_CODES
};
