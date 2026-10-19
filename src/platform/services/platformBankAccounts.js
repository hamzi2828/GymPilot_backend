// src/platform/services/platformBankAccounts.js
//
// GymsPilotPro's own bank accounts, for gyms that pay their subscription by
// transfer: kept on platform_settings.bankAccounts, edited from the panel's
// Payments page, shown on a gym's Billing tab with their QR codes.
//
// The QR images are stored with no gym in context -- the Blob store's
// `platform-bank-qr/` folder (a name no gym can take: gymFiles.SHARED_FOLDERS),
// or the top of the local uploads folder in development.

const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR, localUploadPath, toPublicPath } = require('../../helper/upload');

const QR_FOLDER = 'platform-bank-qr';
const MAX_ACCOUNTS = 10;
const USE_BLOB_STORAGE = () => !!process.env.BLOB_READ_WRITE_TOKEN;

function text(value, max) {
  return value === undefined || value === null ? '' : String(value).trim().slice(0, max);
}

/** An account as the panel reads it. */
function accountView(account) {
  return {
    id: String(account._id),
    bankName: account.bankName || '',
    accountTitle: account.accountTitle || '',
    accountNumber: account.accountNumber || '',
    iban: account.iban || '',
    qrCodeUrl: account.qrCodeUrl || '',
    active: account.active !== false
  };
}

function accountsView(settings) {
  return ((settings && settings.bankAccounts) || []).map(accountView);
}

/** An active account as a gym's Billing tab reads it (snake_case, as the rest of `pay`). */
function gymFacingAccount(account) {
  return {
    bank_name: account.bankName || '',
    account_title: account.accountTitle || '',
    account_number: account.accountNumber || '',
    iban: account.iban || '',
    qr_code_url: account.qrCodeUrl || ''
  };
}

function activeAccounts(settings) {
  return ((settings && settings.bankAccounts) || []).filter((account) => account && account.active !== false);
}

/**
 * What the panel sent for one account, read against the account as it is
 * (`existing`, {} for a new one): every field optional on an edit, the
 * result checked as a whole. Returns { value } or { problem }.
 */
function readAccount(body, existing = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const pick = (key, max) => (b[key] !== undefined ? text(b[key], max) : existing[key] || '');
  const value = {
    bankName: pick('bankName', 80),
    accountTitle: pick('accountTitle', 120),
    accountNumber: pick('accountNumber', 40),
    // Banks print an IBAN in groups of four; it is one string.
    iban: (b.iban !== undefined ? text(b.iban, 60) : existing.iban || '').replace(/\s+/g, '').toUpperCase(),
    active: b.active !== undefined ? b.active === true || b.active === 'true' : existing.active !== false
  };
  if (!value.bankName) return { problem: 'Enter the bank name.' };
  if (!value.accountTitle) return { problem: 'Enter the account title.' };
  if (!value.accountNumber && !value.iban) return { problem: 'Enter the account number or the IBAN.' };
  if (value.iban && !/^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$/.test(value.iban)) return { problem: 'That IBAN does not look right. It starts with two letters and two digits (PK36…).' };
  return { value };
}

/** Where an uploaded QR image is kept: the Blob store in production, the uploads folder otherwise. */
async function storeQr(file) {
  if (USE_BLOB_STORAGE()) {
    const { uploadToBlob } = require('../../helper/blobUpload');
    return uploadToBlob(file.buffer, file.originalname || 'qr', file.mimetype, QR_FOLDER, { kind: 'image' });
  }
  return toPublicPath(file.filename);
}

/**
 * Removes a QR image this module stored. Never another gym's file: locally
 * only one at the top of the uploads folder (gyms' are in their own
 * folders), in the Blob store only one under `platform-bank-qr/`. Never
 * throws: an image left behind must not fail the edit that dropped it.
 */
async function removeQr(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    if (url.startsWith('/uploads/')) {
      const local = localUploadPath(url);
      if (!local || path.dirname(local) !== UPLOADS_DIR) return false;
      await fs.promises.unlink(local);
      return true;
    }
    const { ownBlobUrl, deleteFromBlob } = require('../../helper/blobUpload');
    const own = ownBlobUrl(url, '', QR_FOLDER);
    if (!own) return false;
    await deleteFromBlob(own);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    console.error('[platform] bank QR not removed:', error.message);
    return false;
  }
}

/** Drops a file multer wrote for a request that was then refused. */
function discardUpload(file) {
  if (file && file.path) fs.promises.unlink(file.path).catch(() => {});
}

module.exports = {
  QR_FOLDER,
  MAX_ACCOUNTS,
  accountView,
  accountsView,
  gymFacingAccount,
  activeAccounts,
  readAccount,
  storeQr,
  removeQr,
  discardUpload
};
