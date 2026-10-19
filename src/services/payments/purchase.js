// src/services/payments/purchase.js
//
// A new online purchase for a gateway that is paid against an order (every
// gateway but Stripe, whose own Checkout builds its products and
// subscriptions: gymfolioPaymentService). The rules are the ones Stripe's
// checkout keeps -- shared through membershipService, so the two cannot drift:
//
//   * the price is the package's, read on the server; nothing the browser
//     sends sets an amount
//   * the joining fee is charged once, with the first membership, to the
//     signed-in account (a guest pays it); never decided by a typed email
//   * a coupon comes off the package price only
//   * a signed-in member with a subscription running is not sold another
//
// The order is written pending BEFORE the gateway hears of it, so a payment
// session always has an order to land on. The term is sold as one period:
// renewals come from the payment links and the saved-card charge, not from
// the gateway, so `subscription.autoRenew` stays false and a package's
// Stripe trial days do not apply.

const mongoose = require('mongoose');
const PackageOrder = require('../../gymfolio/models/packageOrderModel');
const Package = require('../../gymfolio/models/packageModel');
const Settings = require('../../models/settings');
const membership = require('../../gymfolio/services/membershipService');
const { parseAmount, resolveCurrency } = require('../../helper/money');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * @param {object} args
 * @param {string|null} args.userId       the signed-in account, or null for a guest
 * @param {string} args.packageId
 * @param {object} args.customerInfo     { fullName, email, phone, country, address, city, state, zipCode }
 * @param {string} [args.couponCode]
 * @param {string} args.provider         the gateway id stored on the order
 * @returns {Promise<object>} the saved pending order
 * @throws {MembershipError} 404 PACKAGE_NOT_FOUND, 400 PACKAGE_NOT_PURCHASABLE /
 *   COUPON_INVALID, 409 SUBSCRIPTION_EXISTS
 */
async function createPendingPurchase({ userId, packageId, customerInfo = {}, couponCode, provider }) {
  const packageData = mongoose.Types.ObjectId.isValid(String(packageId || '')) ? await Package.findById(packageId) : null;
  if (!packageData || !packageData.isActive) throw new membership.MembershipError('This package is not available', 404, 'PACKAGE_NOT_FOUND');

  const listPrice = parseAmount(packageData.price);
  if (listPrice === null || listPrice <= 0) {
    throw new membership.MembershipError(
      listPrice === 0
        ? `${packageData.name} is free, so there is nothing to pay online. Ask at the front desk to join.`
        : `${packageData.name} cannot be bought online. Ask at the front desk to join.`,
      400,
      'PACKAGE_NOT_PURCHASABLE'
    );
  }

  const settings = await Settings.getSettings().catch(() => null);
  const currency = resolveCurrency(packageData.currency, settings && settings.currency);
  const snapshot = membership.packageSnapshot(packageData, currency);
  const payer = await membership.checkoutIdentity(userId);
  const joiningFee = (await membership.joiningFeeDue(payer || {})) ? round2(snapshot.joiningFee) : 0;
  const { coupon, discount } = await membership.applyCoupon(couponCode, packageData, listPrice);
  if (payer) await membership.assertNoActiveSubscription({ ...payer, snapshot });

  const order = new PackageOrder({
    orderNumber: await PackageOrder.generateOrderNumber(),
    userId: payer ? payer.userId : null,
    packageId: packageData._id,
    packageDetails: snapshot,
    customerInfo: {
      fullName: text(customerInfo.fullName, 120) || 'Member',
      email: text(customerInfo.email, 200).toLowerCase(),
      phone: text(customerInfo.phone, 40),
      country: text(customerInfo.country, 60),
      address: text(customerInfo.address),
      city: text(customerInfo.city, 100),
      state: text(customerInfo.state, 100),
      zipCode: text(customerInfo.zipCode, 20)
    },
    payment: {
      method: 'online',
      provider,
      amount: round2(Math.max(0, listPrice + joiningFee - discount)),
      // The coupon comes off the package price alone; the fee is charged whole.
      joiningFee,
      trainerFee: 0,
      subtotal: round2(listPrice + joiningFee),
      discountAmount: discount,
      couponCode: coupon ? coupon.code : '',
      currency: currency.toLowerCase(),
      status: 'pending'
    },
    subscription: { autoRenew: false },
    status: 'pending'
  });
  await order.save();
  return order;
}

/** Closes an order whose payment session could not be opened (as Stripe's checkout does). */
async function closeUnopened(order, error) {
  await PackageOrder.updateOne(
    { _id: order._id, 'payment.status': 'pending' },
    { $set: { 'payment.status': 'failed', status: 'cancelled', 'payment.lastPaymentError': text((error && error.message) || 'Could not open the payment page', 300) } }
  ).catch(() => {});
}

module.exports = { createPendingPurchase, closeUnopened };
