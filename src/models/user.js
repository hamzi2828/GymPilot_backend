//src/model/user.js

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');
const { secretString } = require('../services/secretBox');

// Address sub-schema
const addressSchema = new mongoose.Schema({
    label: { type: String, enum: ['primary', 'secondary'], default: 'primary' },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    country: { type: String, trim: true },
    phoneNumber: { type: String, trim: true },
    isDefault: { type: Boolean, default: false }
}, { _id: true, timestamps: true });

const affiliateCommissionEntrySchema = new mongoose.Schema({
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String, required: true },
    code: { type: String, required: true },
    orderSubtotal: { type: Number, required: true },
    commissionPercent: { type: Number, required: true },
    commissionAmount: { type: Number, required: true },
    status: {
        type: String,
        enum: ['pending', 'approved', 'paid', 'reversed'],
        default: 'pending'
    },
    paidAt: { type: Date, default: null },
    reversedAt: { type: Date, default: null }
}, { _id: true, timestamps: true });

const affiliateSchema = new mongoose.Schema({
    isAffiliate: { type: Boolean, default: false },
    status: {
        type: String,
        enum: ['none', 'pending', 'approved', 'rejected', 'suspended'],
        default: 'none'
    },
    code: { type: String, default: null, trim: true },
    commissionPercent: { type: Number, default: 5, min: 0, max: 100 },
    allowedProducts: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
        default: []
    },
    productsScope: { type: String, enum: ['all', 'selected'], default: 'all' },
    totalEarnings: { type: Number, default: 0 },
    totalPaid: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
    appliedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '' },
    payoutDetails: {
        method: { type: String, default: '' },
        accountTitle: { type: String, default: '' },
        accountNumber: { type: String, default: '' },
        bankName: { type: String, default: '' }
    },
    commissions: { type: [affiliateCommissionEntrySchema], default: [] }
}, { _id: false });

// ---------------------------------------------------------------------------
// Employment
//
// What a person is owed and when they are expected, for accounts that work
// here rather than train here.
//
// `schedule` is the same {day, startTime, endTime} shape a trainer's
// availability uses, and for the same reason: the attendance verdicts
// (on time / late / overtime) already read that shape, so a cleaner's shift
// is judged by exactly the code that judges a trainer's.
// ---------------------------------------------------------------------------

const shiftSchema = new mongoose.Schema({
    day: {
        type: String,
        enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
        required: true
    },
    startTime: { type: String, default: '' },   // 'HH:MM', 24-hour
    endTime: { type: String, default: '' }
}, { _id: false });

const payrollSchema = new mongoose.Schema({
    // salaried -> `salary` per cycle; hourly -> `hourlyRate` x hours worked,
    // which the attendance log already totals.
    basis: { type: String, enum: ['salaried', 'hourly'], default: 'salaried' },
    salary: { type: Number, default: 0, min: 0 },
    hourlyRate: { type: Number, default: 0, min: 0 },
    // Empty = the gym's currency. The staff form stamps the gym's; a change
    // of currency in Settings relabels it (services/currency.js).
    currency: { type: String, default: '', trim: true },
    cycle: { type: String, enum: ['monthly', 'biweekly', 'weekly'], default: 'monthly' },
    contractHoursPerWeek: { type: Number, default: 0, min: 0 },
    // Where the money goes. Kept alongside the rate because payroll is run
    // from one screen and chasing bank details across two is how a payment
    // ends up in the wrong account.
    bankName: { type: String, default: '', trim: true },
    accountTitle: { type: String, default: '', trim: true },
    accountNumber: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true }
}, { _id: false });

const employmentSchema = new mongoose.Schema({
    isStaff: { type: Boolean, default: false, index: true },
    jobTitle: { type: String, default: '', trim: true },
    department: { type: String, default: '', trim: true },
    employmentType: {
        type: String,
        enum: ['full_time', 'part_time', 'contract', 'intern', 'casual'],
        default: 'full_time'
    },
    joinedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    // Pay and bank details ride along only when asked for (`+employment.payroll`,
    // or an inclusive select of `employment`): the users list, the pickers and
    // the member's own profile never need them. See the note on `medical`.
    payroll: { type: payrollSchema, default: () => ({}), select: false },
    schedule: { type: [shiftSchema], default: [] },
    emergencyContact: {
        name: { type: String, default: '', trim: true },
        phone: { type: String, default: '', trim: true },
        relationship: { type: String, default: '', trim: true }
    }
}, { _id: false });

// Health details. A sub-schema rather than a plain nested object because a
// plain object cannot be marked `select: false` as a whole (see the note in
// the user schema); `_id: false` keeps the stored shape exactly what it was.
const medicalSchema = new mongoose.Schema({
    conditions: { type: String, default: '', trim: true },
    medications: { type: String, default: '', trim: true },
    injuries: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },
    // The readiness questionnaire. `flagged` is any "yes".
    parq: {
        completedAt: { type: Date, default: null },
        answers: { type: [{ question: String, answer: Boolean }], default: [] },
        flagged: { type: Boolean, default: false }
    }
}, { _id: false });

// ---- Online payments: saved cards ----
// One card the member saved through the gym's payment gateway. `token` is
// the gateway's reference for the card (Safepay: the wallet payment-method
// token), sealed at rest like a Settings secret; `customerToken` is the
// gateway customer the card is saved under. `autoPay` is whether it is
// charged on each due date; `consentText` is the sentence the member agreed
// to, `consentAt` when.
const savedMethodSchema = new mongoose.Schema({
    id: { type: String, required: true },
    provider: { type: String, required: true, default: 'safepay' },
    token: secretString(),
    customerToken: { type: String, default: null },
    brand: { type: String, default: '' },
    last4: { type: String, default: '' },
    expMonth: { type: Number, default: null },
    expYear: { type: Number, default: null },
    autoPay: { type: Boolean, default: true },
    consentAt: { type: Date, default: null },
    consentText: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
}, { _id: false });

const billingSchema = new mongoose.Schema({
    savedMethods: { type: [savedMethodSchema], default: [] }
}, { _id: false });

// '' and null are "no email": left unset rather than stored, so the partial
// unique index on email never sees them.
function blankToUndefined(value) {
    if (value === null || value === undefined) return undefined;
    return String(value).trim() === '' ? undefined : value;
}

const userSchema = new mongoose.Schema({
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    // Optional: plenty of members at a front desk have no email address, and
    // they sign in with their username instead. Unique only when present (the
    // partial index below); a blank is stored as no field at all, never '',
    // so two members without one never collide and a lookup by email can
    // never match "nobody's". Existing gyms swap the old always-unique index
    // with scripts/migrateEmailIndex.js.
    email: { type: String, lowercase: true, trim: true, set: blankToUndefined },
    // Whether anybody has shown this address is theirs. Sign-up takes any
    // address, and a member may change theirs, so until it is proven the
    // address signs in and receives mail but claims nothing: a guest order
    // bought under it is matched to an account only when this is not false
    // (services/emailVerification.js). Proven by opening the emailed link, a
    // Google sign-in, an emailed sign-in code or an emailed reset link; an
    // account staff made or imported is vouched for, hence the default.
    // Accounts from before the field have no value and count as proven, so
    // only `false` ever means "not yet".
    emailVerified: { type: Boolean, default: true },
    // What the gym reads out to a member so they can sign in on the phone
    // app: their name (or email) plus three digits, unique across the whole
    // platform. Filled in by the hook below wherever an account is created,
    // so no caller has to remember. See services/username.js.
    username: { type: String, trim: true, lowercase: true },
    password: { type: String, required: false, default: null },
    provider: { type: String, enum: ['local', 'google'], default: 'local' },
    googleId: { type: String, default: null, index: true },
    avatarUrl: { type: String, default: null },
    phone: { type: String, default: null },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, default: null },
    // The slug of a Role document, not a fixed list: a gym can invent
    // "Night Duty Manager" without a schema change. Two slugs are reserved --
    // 'user' is every gym member and 'admin' is all-access in code -- and both
    // are seeded as system roles that cannot be deleted.
    role: { type: String, default: 'user', trim: true, lowercase: true, index: true },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date, default: null },

    // ---- Sessions & security -------------------------------------------
    //
    // Bumped to end every session issued before it: a password change,
    // "sign out everywhere", or staff forcing an account out. Carried in
    // the JWT as `tv` and compared by middleware/auth on each request.
    tokenVersion: { type: Number, default: 0 },

    // Single sessions ended by signing out: the token's `jti` and when that
    // token would have expired anyway. Read with tokenVersion by
    // middleware/auth (so it costs no extra query) and pruned of expired
    // entries on every sign-out (controller/securityController.js logout).
    // No default: an account that has never signed out stores nothing.
    revokedSessions: {
      type: [{ _id: false, jti: String, exp: Date }],
      default: undefined,
      select: false
    },

    // Password tries used in the window that ends at signInWindowEndsAt:
    // after ten wrong in a row the password is not checked again for
    // fifteen minutes (services/signInLock.js). No defaults, like the
    // confirmation token below, and never in a query that does not ask.
    signInAttempts: { type: Number, select: false },
    signInWindowEndsAt: { type: Date, select: false },

    // Email code at sign-in. `pending` is the challenge in flight; the hash
    // is never returned by a query that does not ask for it.
    twoFactor: {
      enabled: { type: Boolean, default: false },
      pending: {
        challengeId: { type: String, default: null, index: true },
        codeHash: { type: String, default: null, select: false },
        expiresAt: { type: Date, default: null },
        attempts: { type: Number, default: 0 },
        // The address the code went to. A right code proves that address,
        // not whatever the account's address has been changed to since.
        sentTo: { type: String, default: null },
        // "Remember me" ticked at the password step, carried through to the
        // code step so the token issued there gets the same longer life.
        remember: { type: Boolean, default: false }
      }
    },

    // What the person has agreed to. Fingerprint templates are biometric
    // data; none are stored without this being true, and withdrawing it
    // deletes them.
    consents: {
      biometric: {
        given: { type: Boolean, default: false },
        at: { type: Date, default: null },
        source: { type: String, default: '' },      // portal | desk | admin
        recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        version: { type: String, default: '' }
      }
    },
    // How the member wants to hear from the gym. The channel switches cover
    // the transactional notices (bookings, payments); `marketing` covers
    // campaigns and the automated nudges.
    notificationPreferences: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: true },
      whatsapp: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
      marketing: { type: Boolean, default: true }
    },

    // When the automated messages last went to this member, so nobody is
    // chased twice (services/automations.js).
    automation: {
      absentNudgedAt: { type: Date, default: null },
      winBackSentAt: { type: Date, default: null },
      birthdayYear: { type: Number, default: null }
    },

    // Free labels staff put on a member -- "student", "corporate", "vip" --
    // used to pick campaign audiences and to filter the members list.
    tags: { type: [String], default: [], index: true },

    // ---- Member profile -----------------------------------------------------
    //
    // Filled in by the member from the portal or by staff from Users →
    // Profile. `staffNotes` and `medical.notes` are staff-only and never
    // returned to the member (see services/userView.js).
    //
    // The sensitive blocks -- health, the staff notes, uploaded documents,
    // pay details and the IP an agreement was signed from -- are `select:
    // false`: they leave the database only for a query that names them
    // (`.select('+medical +documents')`), so the users list, the pickers and
    // a sign-in response cannot carry them by accident. A document loaded
    // without them and saved again leaves them untouched (mongoose writes
    // only the paths that changed), but a handler that EDITS one of them must
    // load it first, or `user.medical = user.medical || {}` starts from
    // empty and wipes the rest. See memberProfileController.
    emergencyContact: {
      name: { type: String, default: '', trim: true },
      phone: { type: String, default: '', trim: true },
      relationship: { type: String, default: '', trim: true }
    },
    medical: { type: medicalSchema, default: () => ({}), select: false },
    // The membership agreement (Settings → membership rules), signed by
    // typing a name online or recorded by staff from a paper copy.
    waiver: {
      signedAt: { type: Date, default: null },
      version: { type: String, default: '' },
      signature: { type: String, default: '' },
      source: { type: String, default: '' },      // portal | desk
      ip: { type: String, default: '', select: false },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
    },
    documents: {
      type: [
        new mongoose.Schema(
          {
            name: { type: String, default: '', trim: true },
            url: { type: String, default: '' },
            mimeType: { type: String, default: '' },
            size: { type: Number, default: 0 },
            uploadedAt: { type: Date, default: Date.now },
            uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
          },
          { _id: true }
        )
      ],
      default: [],
      select: false
    },
    staffNotes: { type: String, default: '', select: false },
    goals: { type: String, default: '', trim: true },
    // The member's personal trainer, when they have one.
    assignedTrainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trainer', default: null },
    // How they found the gym.
    source: { type: String, default: '', trim: true },

    addresses: [addressSchema],
    affiliate: { type: affiliateSchema, default: () => ({}) },

    // ---- Front-desk attendance app (GymPilot_desktopApp) ----
    //
    // Two independent grants, both defaulting to No, so the migration to
    // this feature gives nobody anything: an admin turns each on deliberately
    // for the accounts that need it.

    // Without this, correct credentials still fail to sign the desktop app
    // in. Re-checked on every request, so revoking it drops the front-desk PC
    // back to the login screen immediately.
    allowAttendanceApp: { type: Boolean, default: false },

    // Gates the app's "Enroll finger" button AND the enroll endpoint behind
    // it. Requires allowAttendanceApp; on its own it grants nothing.
    allowFingerprintEnrollment: { type: Boolean, default: false },

    // Which branch this account's punches are filed under, shown on the punch
    // receipt so the desk can see where the record is landing.
    attendanceLocation: { type: String, default: '', trim: true },

    // Short human-readable ID the front desk can search by ("GP-0184"), for
    // the days the fingerprint reader is unplugged or the finger won't read.
    // Given to a member when their account is created (assignMemberCode() in
    // peopleDirectory.js); older accounts get one at the desk on first sight
    // or from scripts/assignMemberCodes.js.
    memberCode: { type: String, default: null, trim: true },

    // ---- Employment -------------------------------------------------------
    //
    // Present only on accounts holding a staff role. A gym member's document
    // never grows this block, so "is this person staff" is one field, not a
    // join, and the answer travels with the account they already sign in with.
    employment: { type: employmentSchema, default: () => ({}) },

    // The staff equivalent of memberCode ("TR-0007"), so a cleaner can be
    // found at the desk the same way a member can.
    staffCode: { type: String, default: null, trim: true },

    // ---- Online payments: saved cards (services/safepay/cards.js) ----
    //
    // Cards the member saved, with their consent, to be charged on each due
    // date. Never card data: only the gateway's token for the card (sealed
    // at rest) and what may be shown -- brand, last four digits, expiry.
    // `select: false`, like `medical`: it leaves the database only for a
    // query that names it (`.select('+billing')`), so no profile, list or
    // sign-in response can carry it by accident.
    // No default: an account that never saved a card has no such field.
    billing: { type: billingSchema, default: undefined, select: false },

    // ---- Password reset ---------------------------------------------------
    //
    // Only the SHA-256 hash of the reset token is stored, for the same reason
    // the password itself is hashed: a database dump must not hand anyone a
    // working reset link. The token is generated, mailed, and forgotten.
    //
    // `select: false` keeps both out of every query that does not explicitly
    // ask, so a reset in progress never rides along in an API response.
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },

    // When the password last changed. An audit timestamp, not a gate -- it is
    // recorded, not checked.
    //
    // It does not need to be a gate: there is only ever one outstanding reset
    // token, because requesting a second link overwrites the first one's hash.
    // An older email in the inbox is therefore already dead, and a token is
    // cleared the moment it is spent. This field exists so "when did this
    // account's password last change" is answerable, and as the hook a future
    // change would use to invalidate live sessions issued before a reset --
    // which today's stateless 7-day JWT cannot do.
    passwordChangedAt: { type: Date, default: null, select: false },

    // ---- Email confirmation ------------------------------------------------
    //
    // The link in the "confirm your email" message, kept the way the reset
    // link is: only the hash, with an expiry, cleared when used or when the
    // address changes (services/emailVerification.js). No defaults, so an
    // account that was never sent a link has neither field, and a document
    // fresh from User.create() carries nothing of them into a response.
    emailVerifyTokenHash: { type: String, select: false },
    emailVerifyExpiresAt: { type: Date, select: false },

    // ---- Add member, sent twice ---------------------------------------------
    //
    // The desk's id for the "Add member" request that made this account,
    // when it sent one (memberRegistrationController): the same id arriving
    // again is that request sent again after a lost reply, and is answered
    // with this member rather than by adding a second. No default, so only
    // accounts made that way carry it; never in a query that does not ask.
    registrationRequestId: { type: String, select: false },

}, { timestamps: true });

userSchema.index(
    { 'affiliate.code': 1 },
    { unique: true, partialFilterExpression: { 'affiliate.code': { $type: 'string' } } }
);

// Partial, for the same reason as the affiliate code above: memberCode is
// null on every account that has never been near the front desk, and a plain
// unique index would reject all but the first of them.
userSchema.index(
    { memberCode: 1 },
    { unique: true, partialFilterExpression: { memberCode: { $type: 'string' } } }
);

// Same partial treatment for the staff code: null on every member account.
userSchema.index(
    { staffCode: 1 },
    { unique: true, partialFilterExpression: { staffCode: { $type: 'string' } } }
);

// Unique among the accounts that have one. Named as the old always-unique
// index was, so scripts/migrateEmailIndex.js replaces it in place.
userSchema.index(
    { email: 1 },
    { unique: true, name: 'email_1', partialFilterExpression: { email: { $type: 'string' } } }
);

// One account per "Add member" request id, among the accounts that have one:
// two copies of a request arriving together cannot both make a member.
userSchema.index(
    { registrationRequestId: 1 },
    { unique: true, partialFilterExpression: { registrationRequestId: { $type: 'string' } } }
);

// Sparse: accounts created before usernames existed have no field at all and
// must not all collide on `null` until the backfill runs
// (scripts/assignUsernames.js).
userSchema.index({ username: 1 }, { unique: true, sparse: true });

// Every account gets a username, whoever created it -- the admin screen, the
// sign-up form, a CSV import, Google, a lead being converted, or the owner
// account made when a gym is provisioned. Doing it here rather than at each
// of those call sites is what stops one of them being forgotten.
userSchema.pre('save', async function assignUsernameBeforeSave(next) {
  try {
    if (!this.username) {
      const { generateUsername } = require('../services/username');
      this.username = await generateUsername(this);
    }
    // Publishing to the platform directory is a write to another database,
    // so it only happens when the username is actually new or changed.
    this.$locals.publishUsername = this.isNew || this.isModified('username');
    next();
  } catch (error) {
    next(error);
  }
});

userSchema.post('save', async function publishUsernameAfterSave(doc) {
  if (!doc || !doc.$locals || !doc.$locals.publishUsername) return;
  try {
    const MemberDirectory = require('../platform/models/memberDirectoryModel');
    await MemberDirectory.publish(doc);
  } catch (error) {
    // The account is saved either way; a member who cannot be found by the
    // app is a smaller problem than a failed sign-up, and the backfill
    // script repairs it.
    console.error('[username] could not publish to the member directory:', error.message);
  }
});

module.exports = tenantModel('User', userSchema);
