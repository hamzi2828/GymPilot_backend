// src/models/mobilePushTokenModel.js
//
// A phone running the GymPilot member app that has agreed to receive this
// gym's notifications. One row per device, keyed by the Expo push token the
// app registers after sign-in. A token registered again by another account
// (a shared phone) moves to that account rather than being duplicated, and
// a token Expo reports as DeviceNotRegistered -- the app was uninstalled or
// the token rotated -- is deleted as it is found (see services/messaging.js).
//
// It lives in the gym's own database, beside the browser subscriptions
// (pushSubscriptionModel.js), so one gym's members can never be messaged by
// another gym's staff.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

const PLATFORMS = ['ios', 'android', 'web', 'unknown'];

const mobilePushTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]". Unique within this gym.
    token: { type: String, required: true, unique: true, trim: true },
    platform: { type: String, enum: PLATFORMS, default: 'unknown' },
    // "Sara's iPhone" -- only so a member can tell their devices apart.
    deviceName: { type: String, default: '', trim: true, maxlength: 120 }
  },
  {
    // createdAt, and updatedAt -- bumped every time the app re-registers on
    // launch, so a token nobody has used for months can be told apart from
    // one still in service.
    timestamps: true,
    collection: 'gym_mobile_push_tokens'
  }
);

mobilePushTokenSchema.statics.PLATFORMS = PLATFORMS;

module.exports = tenantModel('MobilePushToken', mobilePushTokenSchema);
