//src/model/user.js

const mongoose = require('mongoose');

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
    currency: { type: String, default: 'PKR', trim: true },
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
    payroll: { type: payrollSchema, default: () => ({}) },
    schedule: { type: [shiftSchema], default: [] },
    emergencyContact: {
        name: { type: String, default: '', trim: true },
        phone: { type: String, default: '', trim: true },
        relationship: { type: String, default: '', trim: true }
    }
}, { _id: false });

const userSchema = new mongoose.Schema({
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
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
    // Assigned on demand -- see ensureMemberCode() in peopleDirectory.js.
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

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
