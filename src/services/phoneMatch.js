// src/services/phoneMatch.js
//
// One phone number, however it was typed. The desk writes the same Pakistani
// mobile as "0301-1234567", "03011234567", "+92 301 1234567" or
// "0092 301 1234567"; stored as typed, a plain text search for one form
// missed the others, and two registrations of the same person went unnoticed.
//
// The number is compared by its "core": the digits after the country code
// (92) or the leading 0 -- 3011234567 for all four forms above. A number from
// another country keeps its own code in the core, so it only ever matches
// itself typed the same international way.

const COUNTRY_CODE = '92';

// What a phone number may be typed with: digits, spaces, + ( ) . and -.
const PHONE_LIKE = /^[\d\s+().-]+$/;

/**
 * The digits that identify a number, without the country code or the
 * leading 0: "0301-1234567", "+923011234567" and "0092 301 1234567" are all
 * "3011234567". '' when there are no digits.
 */
function phoneCore(raw) {
  const text = String(raw || '').trim();
  let digits = text.replace(/\D/g, '');
  if (!digits) return '';
  const international = /^(\+|00)/.test(text);
  if (international && digits.startsWith('00')) digits = digits.slice(2);
  // A bare 92... counts as the country code only at full length (92 + ten
  // digits), so a partial "923" typed into a search is not cut short.
  if ((international || digits.length >= 12) && digits.startsWith(COUNTRY_CODE)) digits = digits.slice(COUNTRY_CODE.length);
  // The trunk 0 ("0301"), also when typed after the code ("+92 0301").
  return digits.replace(/^0+/, '');
}

function digitsPattern(digits) {
  return digits.split('').join('\\D*');
}

/**
 * For a search box: a term that looks like (part of) a phone number, as a
 * pattern matching the stored number in any of its forms -- "0301-123",
 * "+92301123" and "0301123" all find "+92 301 1234567". Null for a term that
 * is not a phone number, or too short to mean one (fewer than four digits).
 */
function phoneSearchPattern(term) {
  const text = String(term || '').trim();
  if (!PHONE_LIKE.test(text)) return null;
  if (text.replace(/\D/g, '').length < 4) return null;
  const core = phoneCore(text);
  return core.length >= 3 ? new RegExp(digitsPattern(core)) : null;
}

/**
 * For "is this number already on file": a pattern matching exactly the same
 * number in any of its forms, or null when `raw` is too short to be one
 * person's number (fewer than seven digits).
 */
function samePhonePattern(raw) {
  const core = phoneCore(raw);
  if (core.length < 7) return null;
  return new RegExp(`^\\D*(?:(?:0\\D*0\\D*)?9\\D*2\\D*)?(?:0\\D*)*${digitsPattern(core)}\\D*$`);
}

/** Whether two typed numbers are the same number. */
function samePhone(a, b) {
  const left = phoneCore(a);
  return left.length >= 7 && left === phoneCore(b);
}

/**
 * Why a typed phone number cannot be saved, or null when it can (an empty
 * one included -- leaving the box empty is allowed). Digits with spaces,
 * dashes, dots or brackets, at most one + at the front: "0301-1234567",
 * "+92 301 1234567" and "0092 301 1234567" all pass, "abc" does not. A
 * number from abroad is fine too, by the international limit of 7 to 15
 * digits.
 */
function phoneProblem(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  if (!PHONE_LIKE.test(text) || /.\+/.test(text) || digits.length < 7 || digits.length > 15) {
    return 'Please enter a valid phone number, for example 0301 1234567 or +92 301 1234567.';
  }
  return null;
}

module.exports = { phoneCore, phoneSearchPattern, samePhonePattern, samePhone, phoneProblem };
