// src/services/billing/banks.js
//
// The gym's own bank accounts (Settings → Banks), as the no-fee way to pay
// a renewal: shown on the payment link page and added to every reminder.
// A transfer from any Pakistani bank app to an IBAN goes over Raast, so the
// IBAN is the Raast detail; the account's QR image, when it has one, is
// what a banking app scans.

const Bank = require('../../models/bank');

/** The accounts members may pay into, oldest first (as the checkout lists them). */
async function activeBanks() {
  try {
    return await Bank.find({ isActive: true, isDeleted: { $ne: true } })
      .select('_id name accountTitle accountNumber branch iban notes qrCodeUrl')
      .sort({ createdAt: 1 })
      .lean();
  } catch (error) {
    console.error('[billing] could not read the bank accounts:', error.message);
    return [];
  }
}

/** The public shape of an account, for the payment link page. */
function bankView(bank) {
  return {
    id: bank._id ? String(bank._id) : null,
    bank_name: bank.name || '',
    account_title: bank.accountTitle || '',
    account_number: bank.accountNumber || '',
    iban: bank.iban || '',
    branch: bank.branch || '',
    notes: bank.notes || '',
    qr_code_url: bank.qrCodeUrl || ''
  };
}

/** One line per account, for a text message: "Meezan Bank, Iron Gym, IBAN PK36..." */
function bankLine(bank) {
  const number = bank.iban ? `IBAN ${bank.iban}` : `A/C ${bank.accountNumber || ''}`.trim();
  return [bank.name, bank.accountTitle, number].filter(Boolean).join(', ');
}

/**
 * The bank alternative in a short message: the first account only (an SMS
 * has no room for more), or '' when the gym has none.
 */
function bankText(banks) {
  if (!banks || !banks.length) return '';
  return `Or pay by bank transfer / Raast (no fee): ${bankLine(banks[0])}.`;
}

module.exports = { activeBanks, bankView, bankLine, bankText };
