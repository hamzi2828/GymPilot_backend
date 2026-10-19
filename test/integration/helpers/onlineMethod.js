// test/integration/helpers/onlineMethod.js
//
// The renewal orders a payment link is sent for are `payment.method:
// 'online'`. That method is added to services/paymentMethods.js by the
// payment-gateway work (the Safepay branch); until both are merged, the
// billing tests put it on the list themselves, before the order model is
// first loaded -- its enum is read once, when the schema is built. Once the
// list has it, this does nothing.

'use strict';

const path = require('path');

module.exports = function allowOnlineMethod(h) {
  const methods = h.src('services/paymentMethods').PAYMENT_METHODS;
  if (methods.includes('online')) return;
  const model = require.resolve(path.join(__dirname, '..', '..', '..', 'src', 'gymfolio', 'models', 'packageOrderModel'));
  if (require.cache[model]) throw new Error('[integration] allowOnlineMethod must run before the order model is loaded');
  methods.push('online');
};
