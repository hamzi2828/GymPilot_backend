// src/helper/emailShape.js
//
// Whether a string has the shape of one email address: local@domain.tld.
//
// The models used to say so with a pattern like /^\w+([.-]?\w+)*@.../ --
// a group inside a repeat, which a regex engine can split up in
// exponentially many ways before it gives up. Forty characters that almost
// match held the event loop for minutes, and the contact and newsletter forms
// are public. Three of them also refused any top-level domain longer than
// three letters (.info, .fitness).
//
// This check does a fixed amount of work per character: a length cap first,
// one split at the "@" and at each ".", and single character-class tests with
// no group to repeat. It is about shape only; whether mail arrives is for the
// mail server to say.

const MAX_LENGTH = 254; // the longest address a mail server will take (RFC 5321)
const MAX_LOCAL = 64;
const MAX_LABEL = 63;

// Letters, digits and the punctuation addresses really use (plus addressing,
// o'brien@...). Nothing a mail header or an HTML attribute would read as markup.
const LOCAL_CHARS = /^[A-Za-z0-9._%+'-]+$/;
// One part of the domain. "_" was accepted before and is kept.
const LABEL_CHARS = /^[A-Za-z0-9_-]+$/;
const TLD = /^[A-Za-z]{2,63}$/;

/** True when `value` looks like one email address. Never throws. */
function isEmailShape(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return false;

  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);

  if (local.length > MAX_LOCAL || !LOCAL_CHARS.test(local)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;

  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!label || label.length > MAX_LABEL || !LABEL_CHARS.test(label)) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
  }
  return TLD.test(labels[labels.length - 1]);
}

/**
 * A mongoose `validate` for an email field. An empty value passes, so an
 * optional field stays optional; `required` says whether one is needed.
 */
function emailValidator(message = 'Please enter a valid email') {
  return {
    validator: (value) => value === undefined || value === null || value === '' || isEmailShape(value),
    message
  };
}

module.exports = { isEmailShape, emailValidator, MAX_LENGTH };
