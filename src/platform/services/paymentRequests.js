// src/platform/services/paymentRequests.js
//
// Gyms paying GymsPilotPro by bank transfer: the gym transfers to one of
// GymsPilotPro's accounts (System → Payments), uploads the receipt from its
// Billing tab (submitReceipt), and the super admin approves or rejects it
// from "Payments to verify":
//
//   approve  records the payment through manualPayments.recordPayment
//            (method 'bank_transfer', the gym's reference), which moves the
//            paid-until date and makes the subscription active -- once,
//            however often it is approved: the payment's request id is the
//            request's own
//   reject   keeps the reason; the gym sees it and can upload again
//
// The gym's owner is emailed either way when the platform can send email
// (SMTP_*); the answer says whether it was (`emailed`).

const Gym = require('../models/gymModel');
const PlatformPayment = require('../models/platformPaymentModel');
const PlatformPaymentRequest = require('../models/platformPaymentRequestModel');
const PlatformSettings = require('../models/platformSettingsModel');
const manualPayments = require('./manualPayments');
const { PlatformPayError, payTerms } = require('./platformPay');
const { activeAccounts } = require('./platformBankAccounts');
const { platformEmailConfigured } = require('./platformEmail');
const { siteUrlFor } = require('../tenantContext');
// Called through the module, so the stand-in a test installs is the one used.
const emailService = require('../../services/emailService');
const { shell, paragraph, button, detailTable, callout, dateLabel, escapeHtml } = require('../../templates/gymEmails');

const PLATFORM_NAME = process.env.PLATFORM_NAME || 'GymsPilotPro';
const RECEIPT_FOLDER = 'platform-receipts';
// An approval left half-way (the request died) stops holding up a rejection after this.
const STALE_APPROVAL_MS = 10 * 60 * 1000;
const PAGE_LIMIT = 100;

function text(value, max) {
  return value === undefined || value === null ? '' : String(value).trim().slice(0, max);
}

function iso(date) {
  return date ? new Date(date).toISOString() : null;
}

/** A request as the super admin's "Payments to verify" reads it. */
function publicRequest(row) {
  if (!row) return null;
  const by = row.submittedBy || {};
  const reviewer = row.reviewedBy || {};
  return {
    id: String(row._id),
    gymId: String(row.gymId),
    gymSlug: row.gymSlug || '',
    gymName: row.gymName || '',
    amount: Number(row.amount) || 0,
    currency: row.currency,
    billingCycle: row.billingCycle || 'monthly',
    receiptUrl: row.receiptUrl,
    reference: row.reference || '',
    note: row.note || '',
    submittedAt: iso(row.submittedAt),
    submittedBy: { id: by.id || '', email: by.email || '', name: by.name || '' },
    status: row.status,
    reason: row.reason || '',
    reviewedAt: iso(row.reviewedAt),
    reviewedBy: row.reviewedAt ? { id: reviewer.id ? String(reviewer.id) : '', email: reviewer.email || '' } : null,
    paymentId: row.paymentId ? String(row.paymentId) : null
  };
}

/** The subscription as an answer to the panel shows it after a payment. */
function subscriptionView(gym) {
  const sub = (gym && gym.subscription) || {};
  return {
    status: sub.status || '',
    billingCycle: sub.billingCycle || 'monthly',
    currentPeriodEnd: iso(sub.currentPeriodEnd),
    amount: Number(sub.amount) || 0,
    currency: String(sub.currency || 'PKR').toUpperCase()
  };
}

/** A request as the gym's Billing tab reads it (`pay.pending_request`). */
function gymView(row) {
  if (!row) return null;
  return {
    status: row.status === 'pending' || row.status === 'rejected' ? row.status : null,
    reason: row.status === 'rejected' ? row.reason || '' : '',
    submitted_at: iso(row.submittedAt),
    amount: Number(row.amount) || 0
  };
}

/**
 * Where the gym's latest receipt stands: pending, or rejected (with why)
 * until it uploads again -- or pays some other way since. Null when there
 * is none, or it was approved.
 */
async function pendingRequestFor(gymId) {
  const latest = await PlatformPaymentRequest.findOne({ gymId }).sort({ submittedAt: -1, _id: -1 }).lean();
  if (!latest || latest.status === 'approved') return null;
  if (latest.status === 'rejected' && latest.reviewedAt) {
    const paidSince = await PlatformPayment.exists({ gymId, createdAt: { $gt: latest.reviewedAt } });
    if (paidSince) return null;
  }
  return gymView(latest);
}

/** Where an uploaded receipt is kept: the Blob store in production, the gym's uploads folder otherwise. */
async function storeReceipt(file) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { uploadToBlob } = require('../../helper/blobUpload');
    return uploadToBlob(file.buffer, file.originalname || 'receipt', file.mimetype, RECEIPT_FOLDER, { kind: 'proof' });
  }
  const { toPublicPath } = require('../../helper/upload');
  return toPublicPath(file.filename);
}

/** Removes a receipt of the gym in context (deleteStoredFile never touches another gym's). */
function removeReceipt(url) {
  if (!url) return Promise.resolve(false);
  return require('../../helper/blobUpload').deleteStoredFile(url, RECEIPT_FOLDER);
}

function discardUpload(file) {
  if (file && file.path) require('fs').promises.unlink(file.path).catch(() => {});
}

/**
 * The gym's receipt (POST /api/billing/receipt), inside the gym's tenant
 * context. Taken when GymsPilotPro lists an active bank account to pay into
 * -- bank transfer is the way, or the accounts are there as a fallback --
 * and never for a gym Stripe bills. Replaces a pending one (its file is
 * removed).
 *
 * @returns {Promise<object>} the request row
 * @throws {PlatformPayError} 400 RECEIPT_REQUIRED / NOTHING_TO_PAY / INVALID_CYCLE,
 *   409 STRIPE_BILLED / BANK_TRANSFER_OFF / REVIEW_IN_PROGRESS
 */
async function submitReceipt({ gym, file, body = {}, user = null, now = new Date() }) {
  const sub = (gym && gym.subscription) || {};
  let terms;
  try {
    if (sub.stripeSubscriptionId) {
      throw new PlatformPayError('This gym pays by card through Stripe, which records its payments itself.', 409, 'STRIPE_BILLED');
    }
    const settings = await PlatformSettings.getSettings();
    if (!activeAccounts(settings).length) {
      throw new PlatformPayError(`GymsPilotPro has no bank account to pay into yet. Contact ${process.env.PLATFORM_CONTACT_EMAIL || 'GymsPilotPro'} to pay.`, 409, 'BANK_TRANSFER_OFF');
    }
    if (!file) throw new PlatformPayError('Choose the receipt to upload: a photo or a PDF.', 400, 'RECEIPT_REQUIRED');
    terms = await payTerms(gym, { billingCycle: body.billingCycle || undefined });
  } catch (error) {
    discardUpload(file);
    throw error;
  }

  const receiptUrl = await storeReceipt(file);
  const fields = {
    gymSlug: gym.slug,
    gymName: gym.name || gym.slug,
    amount: terms.amount,
    currency: terms.currency,
    billingCycle: terms.billingCycle,
    change: terms.change || null,
    receiptUrl,
    reference: text(body.reference, 120),
    note: text(body.note, 1000),
    submittedAt: now,
    submittedBy: {
      id: user && (user.id || user._id) ? String(user.id || user._id) : '',
      email: (user && user.email) || '',
      name: (user && [user.firstName, user.lastName].filter(Boolean).join(' ')) || (user && user.name) || ''
    }
  };

  // The pending one, replaced in place -- unless the super admin is
  // approving it right now.
  const replace = () =>
    PlatformPaymentRequest.findOneAndUpdate({ gymId: gym._id, status: 'pending', approvingAt: null }, { $set: fields }, { new: false }).lean();
  try {
    let previous = await replace();
    if (!previous) {
      if (await PlatformPaymentRequest.exists({ gymId: gym._id, status: 'pending' })) {
        throw new PlatformPayError('GymsPilotPro is confirming your last receipt right now. Try again in a minute.', 409, 'REVIEW_IN_PROGRESS');
      }
      try {
        await PlatformPaymentRequest.create({ gymId: gym._id, status: 'pending', ...fields });
      } catch (error) {
        if (!error || error.code !== 11000) throw error;
        // Two uploads at once: the other made the pending one; this replaces it.
        previous = await replace();
        if (!previous) throw new PlatformPayError('GymsPilotPro is confirming your last receipt right now. Try again in a minute.', 409, 'REVIEW_IN_PROGRESS');
      }
    }
    if (previous && previous.receiptUrl && previous.receiptUrl !== receiptUrl) await removeReceipt(previous.receiptUrl);
  } catch (error) {
    await removeReceipt(receiptUrl);
    throw error;
  }
  return PlatformPaymentRequest.findOne({ gymId: gym._id, status: 'pending' }).lean();
}

/** GET /api/platform/payment-requests: newest first, by status (default every one). */
async function listRequests({ status, gymId, page = 1, limit = 50 } = {}) {
  const filter = {};
  if (status && PlatformPaymentRequest.schema.statics.STATUSES.includes(status)) filter.status = status;
  if (gymId) filter.gymId = gymId;
  const size = Math.min(PAGE_LIMIT, Math.max(1, parseInt(limit, 10) || 50));
  const skip = (Math.max(1, parseInt(page, 10) || 1) - 1) * size;
  const [rows, total] = await Promise.all([
    PlatformPaymentRequest.find(filter).sort({ submittedAt: -1, _id: -1 }).skip(skip).limit(size).lean(),
    PlatformPaymentRequest.countDocuments(filter)
  ]);
  return { data: rows.map(publicRequest), total };
}

function countPending() {
  return PlatformPaymentRequest.countDocuments({ status: 'pending' });
}

/* --------------------------------- emails --------------------------------- */

function billingLink(gym) {
  const site = String(siteUrlFor(gym) || '').replace(/\/+$/, '');
  return `${site}/admin/settings?tab=billing`;
}

function money(amount, currency) {
  return `${String(currency || '').toUpperCase()} ${Number(amount || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function approvedEmail({ gym, request }) {
  const firstName = (gym.owner && gym.owner.firstName) || 'there';
  const body = [
    paragraph(`Hi ${escapeHtml(firstName)}, we have received your payment for ${escapeHtml(gym.name)}. Thank you.`),
    detailTable([
      ['Amount', money(request.amount, request.currency)],
      ['Paid until', dateLabel(gym.subscription && gym.subscription.currentPeriodEnd) || '']
    ]),
    button(billingLink(gym), 'View billing')
  ].join('');
  return { subject: `${gym.name}: payment received — thank you`, html: shell(PLATFORM_NAME, 'Payment received', body) };
}

function rejectedEmail({ gym, request }) {
  const firstName = (gym.owner && gym.owner.firstName) || 'there';
  const body = [
    paragraph(`Hi ${escapeHtml(firstName)}, we could not confirm the payment receipt ${escapeHtml(gym.name)} sent on ${escapeHtml(dateLabel(request.submittedAt) || 'recently')}.`),
    callout(`Why: ${escapeHtml(request.reason)}`, 'bad'),
    paragraph('Please upload the right receipt under Settings → Billing.'),
    button(billingLink(gym), 'Upload receipt')
  ].join('');
  return { subject: `${gym.name}: we could not confirm your payment`, html: shell(PLATFORM_NAME, 'Payment not confirmed', body) };
}

/** Emails the gym's owner; false when the platform has no email, no owner address, or the send failed. */
async function tellOwner(build, gym, request) {
  const to = gym && gym.owner && gym.owner.email;
  if (!to || !platformEmailConfigured()) return false;
  try {
    const { subject, html } = build({ gym, request });
    const result = await emailService.sendEmail(to, subject, html);
    return !!(result && result.success);
  } catch (error) {
    console.error(`[payment-requests] email to ${gym.slug}'s owner failed:`, error.message);
    return false;
  }
}

/* ------------------------------ approve / reject ------------------------------ */

async function loadRequest(id) {
  const mongoose = require('mongoose');
  if (!mongoose.Types.ObjectId.isValid(String(id))) return null;
  return PlatformPaymentRequest.findById(id).lean();
}

/**
 * Approves a pending request: the payment recorded, the subscription
 * extended, the request marked approved. Approving one already approved
 * answers with what it recorded (`duplicate: true`) and changes nothing.
 *
 * @returns {Promise<{ request, payment, gym, duplicate, emailed }>}
 * @throws {PlatformPayError} 404 NOT_FOUND / GYM_NOT_FOUND, 409 ALREADY_REJECTED;
 *   ManualPaymentError (STRIPE_BILLED, DUPLICATE_REFERENCE, INVALID_PAYMENT)
 */
async function approve({ id, actor, now = new Date() }) {
  const request = await loadRequest(id);
  if (!request) throw new PlatformPayError('That payment request does not exist.', 404, 'NOT_FOUND');
  if (request.status === 'rejected') throw new PlatformPayError('This receipt was rejected. The gym can upload it again.', 409, 'ALREADY_REJECTED');
  const gym = await Gym.findByIdWithUri(request.gymId);
  if (request.status === 'approved') {
    const payment = request.paymentId ? await PlatformPayment.findById(request.paymentId).lean() : null;
    return { request, payment, gym, duplicate: true, emailed: false };
  }
  if (!gym) throw new PlatformPayError('The gym this receipt is from no longer exists.', 404, 'GYM_NOT_FOUND');

  await PlatformPaymentRequest.updateOne({ _id: request._id, status: 'pending' }, { $set: { approvingAt: now } });
  let outcome;
  try {
    outcome = await manualPayments.recordPayment({
      gym,
      input: {
        amount: request.amount,
        method: 'bank_transfer',
        // Every bank transfer is kept with a reference; a receipt sent
        // without one is known by its request.
        reference: request.reference || `receipt-${String(request._id).slice(-8)}`,
        note: request.note || 'Bank transfer receipt uploaded from the Billing tab',
        receivedAt: request.submittedAt,
        requestId: `receipt:${request._id}`
      },
      actor,
      change: request.change || null,
      now
    });
  } catch (error) {
    await PlatformPaymentRequest.updateOne({ _id: request._id, status: 'pending' }, { $set: { approvingAt: null } }).catch(() => {});
    throw error;
  }

  const reviewed = { status: 'approved', reviewedAt: now, reviewedBy: { id: (actor && actor._id) || null, email: (actor && actor.email) || '' }, paymentId: outcome.payment._id, approvingAt: null };
  const updated =
    (await PlatformPaymentRequest.findOneAndUpdate({ _id: request._id, status: 'pending' }, { $set: reviewed }, { new: true }).lean()) ||
    (await PlatformPaymentRequest.findById(request._id).lean());
  const fresh = (await Gym.findByIdWithUri(request.gymId)) || gym;
  const emailed = outcome.duplicate ? false : await tellOwner(approvedEmail, fresh, updated);
  return { request: updated, payment: outcome.payment, gym: fresh, duplicate: !!outcome.duplicate, emailed };
}

/**
 * Rejects a pending request with the reason the gym will be shown.
 * Rejecting one already rejected answers with it.
 *
 * @returns {Promise<{ request, gym, emailed }>}
 * @throws {PlatformPayError} 400 REASON_REQUIRED, 404 NOT_FOUND,
 *   409 ALREADY_APPROVED / APPROVAL_IN_PROGRESS
 */
async function reject({ id, reason, actor, now = new Date() }) {
  const why = text(reason, 500);
  if (!why) throw new PlatformPayError('Say why the receipt is rejected: the gym is shown this.', 400, 'REASON_REQUIRED');
  const request = await loadRequest(id);
  if (!request) throw new PlatformPayError('That payment request does not exist.', 404, 'NOT_FOUND');
  if (request.status === 'approved') throw new PlatformPayError('This payment is already approved and recorded.', 409, 'ALREADY_APPROVED');
  const gym = await Gym.findByIdWithUri(request.gymId);
  if (request.status === 'rejected') return { request, gym, emailed: false, duplicate: true };

  // An approval under way, or one that recorded the payment and died before
  // marking the request: not to be undone by a rejection.
  if (await PlatformPayment.exists({ gymId: request.gymId, requestId: `receipt:${request._id}` })) {
    throw new PlatformPayError('This payment is being approved. Reload the list.', 409, 'APPROVAL_IN_PROGRESS');
  }
  const updated = await PlatformPaymentRequest.findOneAndUpdate(
    { _id: request._id, status: 'pending', $or: [{ approvingAt: null }, { approvingAt: { $lt: new Date(now.getTime() - STALE_APPROVAL_MS) } }] },
    { $set: { status: 'rejected', reason: why, reviewedAt: now, reviewedBy: { id: (actor && actor._id) || null, email: (actor && actor.email) || '' }, approvingAt: null } },
    { new: true }
  ).lean();
  if (!updated) {
    const current = await PlatformPaymentRequest.findById(request._id).lean();
    if (current && current.status === 'approved') throw new PlatformPayError('This payment is already approved and recorded.', 409, 'ALREADY_APPROVED');
    if (current && current.status === 'rejected') return { request: current, gym, emailed: false, duplicate: true };
    throw new PlatformPayError('This payment is being approved. Reload the list.', 409, 'APPROVAL_IN_PROGRESS');
  }
  const emailed = gym ? await tellOwner(rejectedEmail, gym, updated) : false;
  return { request: updated, gym, emailed };
}

module.exports = {
  RECEIPT_FOLDER,
  publicRequest,
  gymView,
  subscriptionView,
  pendingRequestFor,
  submitReceipt,
  listRequests,
  countPending,
  approve,
  reject,
  approvedEmail,
  rejectedEmail
};
