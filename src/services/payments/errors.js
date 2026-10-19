// src/services/payments/errors.js

/**
 * A payment gateway that cannot do what was asked: none chosen, not set up,
 * or not offering that (a Stripe gym has no payment links). `status` is the
 * HTTP status to answer with, `code` the machine-readable reason.
 */
class PaymentGatewayError extends Error {
  constructor(message, code = 'GATEWAY_ERROR', status = 409) {
    super(message);
    this.name = 'PaymentGatewayError';
    this.code = code;
    this.status = status;
  }
}

module.exports = { PaymentGatewayError };
