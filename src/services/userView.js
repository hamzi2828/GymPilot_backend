// src/services/userView.js
//
// The one shape a user's own account is handed back in: sign-in, Google
// sign-in, the second factor step, the profile screen and profile edits all
// return this, so what a member can see about themselves is decided in one
// place rather than in five slightly different destructurings.
//
// What is left out, and why:
//
//   password, reset token, twoFactor.pending  -- credentials, never
//   staffNotes, medical                       -- staff-only notes about the
//                                                member (the member edits
//                                                their own health details
//                                                through /user/health)
//   documents, employment.payroll, waiver.ip  -- staff screens read these
//                                                through their own endpoints
//   automation, registrationRequestId         -- bookkeeping: the nudges,
//                                                and the desk's id for the
//                                                request that made the account
//
// Everything the website and the phone app read stays: firstName, lastName,
// email, username, role, phone, avatarUrl, twoFactor.enabled, consents,
// notificationPreferences, addresses and the rest.

function publicUserView(user) {
  if (!user) return null;
  const raw = user.toObject ? user.toObject() : { ...user };

  const {
    password: _password,
    passwordResetTokenHash: _resetHash,
    passwordResetExpiresAt: _resetExpiry,
    passwordChangedAt: _changedAt,
    staffNotes: _staffNotes,
    medical: _medical,
    documents: _documents,
    automation: _automation,
    registrationRequestId: _registrationRequestId,
    twoFactor,
    ...safe
  } = raw;

  safe.twoFactor = { enabled: !!(twoFactor && twoFactor.enabled) };

  if (safe.waiver && typeof safe.waiver === 'object') {
    const { ip: _ip, ...waiver } = safe.waiver;
    safe.waiver = waiver;
  }

  if (safe.employment && typeof safe.employment === 'object') {
    const { payroll: _payroll, ...employment } = safe.employment;
    safe.employment = employment;
  }

  return safe;
}

module.exports = { publicUserView };
