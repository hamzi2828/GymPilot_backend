// src/platform/services/payments/providers/generic.js
//
// "Bank transfer + receipt": no payment company. A gym transfers to one of
// GymsPilotPro's own bank accounts (platform_settings.bankAccounts, with
// their QR codes), uploads the receipt from its Billing tab, and the super
// admin approves it (services/paymentRequests.js), which records the
// payment the way a payment typed in by hand is (manualPayments).
// Ready once there is an active bank account.

function activeAccounts(settings) {
  return ((settings && settings.bankAccounts) || []).filter((account) => account && account.active !== false);
}

module.exports = {
  id: 'generic',
  label: 'Bank transfer + receipt',
  description: 'Gyms upload a receipt, you approve.',
  checkoutLabel: 'Bank transfer — upload your receipt',
  settingsKey: null,
  configFields: [],

  isConfigured(settings) {
    return activeAccounts(settings).length > 0;
  },

  async testConnection(input, settings) {
    const count = activeAccounts(settings).length;
    if (!count) return { success: false, message: 'Add a bank account (and its QR code, if it has one) first.' };
    return { success: true, message: `${count} bank account${count === 1 ? ' is' : 's are'} ready for transfers.`, data: { bankAccounts: count } };
  },

  webhookUrl() {
    return null;
  },

  activeAccounts
};
