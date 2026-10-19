// src/services/payments/providers/generic.js
//
// "Generic": no payment company at all, so it works in any country. Members
// pay by bank transfer into one of the gym's own accounts (Settings → Banks,
// with their QR images) and upload a screenshot of the receipt; staff check
// it in the existing bank-transfer review (payment.method 'bank_transfer',
// payment.status 'processing') and approve or reject it.
//
// It takes no money itself, so it opens no checkout, charges no card and
// receives no webhook. What it offers is what the bank-transfer flow and
// the payment links already do: the website's bank-transfer checkout, and
// the receipt upload on the pay link page. It has no settings of its own;
// it is ready once the gym has an active bank account.

const Bank = require('../../../models/bank');
const { PaymentGatewayError } = require('../errors');

const NO_BANKS = 'NO_BANK_ACCOUNTS';
const BANK_TRANSFER_ONLY = 'This gym takes payment by bank transfer: choose bank transfer and upload your receipt.';

async function activeBankCount() {
  return Bank.countDocuments({ isActive: true, isDeleted: { $ne: true } });
}

function unsupported(what) {
  return new PaymentGatewayError(`${what} is not offered with bank transfer: ${BANK_TRANSFER_ONLY}`, 'GATEWAY_UNSUPPORTED', 409);
}

async function status() {
  const banks = await activeBankCount().catch(() => 0);
  return banks > 0
    ? { available: true, code: null, reason: '' }
    : { available: false, code: NO_BANKS, reason: 'Bank transfer is not available at this gym yet.' };
}

module.exports = {
  id: 'generic',
  label: 'Generic — bank transfer with receipt (works anywhere)',
  description: 'No payment company needed: members transfer to the gym’s own bank account (Settings → Banks) and upload the receipt; staff approve it.',
  countries: ['*'],
  checkoutLabel: 'Bank transfer — upload your receipt',
  settingsKey: null,
  capabilities: { checkout: false, paymentLinks: true, receiptUpload: true, savedCards: false, autoCharge: false, wallets: false, bankApps: true },
  configFields: [],

  /** Ready once the gym has at least one active bank account. */
  async isConfigured() {
    return (await status()).available;
  },

  status,

  async unavailableError() {
    const { available } = await status();
    return new PaymentGatewayError(available ? BANK_TRANSFER_ONLY : 'Bank transfer is not available at this gym yet. Please pay at the front desk.', available ? 'BANK_TRANSFER_ONLY' : NO_BANKS, 409);
  },

  async testConnection() {
    const banks = await activeBankCount();
    if (!banks) return { success: false, message: 'No bank account is ready: add one under Settings → Banks (with its QR code, if it has one).' };
    return { success: true, message: `${banks} bank account${banks === 1 ? ' is' : 's are'} ready for transfers.`, data: { banks } };
  },

  /** Members buy through the bank-transfer checkout (POST /api/gymfolio/payment/bank-transfer). */
  async createPurchaseCheckout() {
    throw new PaymentGatewayError(BANK_TRANSFER_ONLY, 'BANK_TRANSFER_ONLY', 409);
  },

  async createCheckout() {
    throw unsupported('An online checkout');
  },

  async chargeSavedMethod() {
    return { status: 'failed', reference: null, tracker: null, reason: 'Bank transfers are not charged automatically.', code: 'GATEWAY_UNSUPPORTED' };
  },

  async fetchStatus() {
    throw unsupported('A payment status from a gateway');
  },

  async verifyWebhook() {
    throw unsupported('A webhook');
  },

  webhookUrl() {
    return null;
  },

  activeBankCount
};
