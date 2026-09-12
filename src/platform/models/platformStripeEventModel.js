// src/platform/models/platformStripeEventModel.js
//
// Every Stripe event the platform webhook has acted on, by Stripe's event
// id. Stripe delivers an event at least once -- a slow answer, a deploy in
// the middle of a request, and the same event arrives again -- so the
// webhook claims the id here before it touches a gym, and a second delivery
// finds the claim and is acknowledged without being applied twice.

const mongoose = require('mongoose');
const { platformModel } = require('../platformDb');

const platformStripeEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, default: '', index: true },
    livemode: { type: Boolean, default: false },
    // Which gym it ended up changing, when it did.
    gymId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', default: null },
    gymSlug: { type: String, default: '' },
    // What the handler did, in a word ("subscription activated"), or why it
    // did nothing ("no gym matched").
    result: { type: String, default: '' },
    handledAt: { type: Date, default: null }
  },
  {
    timestamps: true,
    collection: 'platform_stripe_events'
  }
);

platformStripeEventSchema.index({ createdAt: -1 });

/**
 * Claims an event id. Resolves true when this call was the first to see it,
 * false when it had already been claimed -- the atomic upsert is what makes
 * two deliveries of one event, seconds apart, end up applied exactly once.
 */
platformStripeEventSchema.statics.claim = async function (event) {
  const result = await this.updateOne(
    { eventId: event.id },
    { $setOnInsert: { eventId: event.id, type: event.type || '', livemode: !!event.livemode } },
    { upsert: true }
  );
  return result.upsertedCount === 1;
};

/** Lets a retry try again: called when the handler threw before finishing. */
platformStripeEventSchema.statics.release = function (event) {
  return this.deleteOne({ eventId: event.id, handledAt: null }).catch(() => null);
};

platformStripeEventSchema.statics.markHandled = function (event, { gym = null, result = '' } = {}) {
  return this.updateOne(
    { eventId: event.id },
    { $set: { handledAt: new Date(), result, gymId: gym ? gym._id : null, gymSlug: gym ? gym.slug : '' } }
  ).catch(() => null);
};

module.exports = platformModel('PlatformStripeEvent', platformStripeEventSchema);
