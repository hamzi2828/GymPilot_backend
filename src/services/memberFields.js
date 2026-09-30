// src/services/memberFields.js
//
// The profile details the desk takes down while creating a member -- gender,
// date of birth, a one-line address and the staff's own note -- turned into
// the fields a new user document holds. Everything else about a member
// (health, emergency contact, documents, tags) is edited afterwards on
// Users -> Profile.
//
// Shaped like the rest of the account:
//
//   gender       free text up to 20 characters, as the profile edit and the
//                CSV import take it ("male", "female", "other" from the form)
//   dateOfBirth  a real date, not in the future
//   address      one line, stored as the account's primary address -- the
//                same `addresses[]` entry the member's own address book and
//                the checkout read, so nothing needs a second shape
//   staffNotes   staff-only (`select: false` on the model, never shown to
//                the member -- services/userView.js)
//
// Every field is optional; a blank one is simply left out.

const MAX_GENDER = 20;
const MAX_ADDRESS = 300;
const MAX_NOTES = 10000;

/** One line: whatever was pasted with line breaks reads as one address. */
function oneLine(value) {
  return String(value || '').replace(/[,\s]*[\r\n]+\s*/g, ', ').trim();
}

function blank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * @returns {{ fields: object } | { problem: string }} fields to spread into
 *   User.create, or the sentence explaining what is wrong.
 */
function profileFieldsFrom(body = {}, now = new Date()) {
  const fields = {};

  if (!blank(body.gender)) {
    const gender = String(body.gender).trim().toLowerCase();
    if (gender.length > MAX_GENDER) return { problem: `Gender can be at most ${MAX_GENDER} characters` };
    fields.gender = gender;
  }

  if (!blank(body.dateOfBirth)) {
    const date = new Date(body.dateOfBirth);
    if (Number.isNaN(date.getTime())) return { problem: 'Date of birth is not a date' };
    if (date > now) return { problem: 'Date of birth cannot be in the future' };
    fields.dateOfBirth = date;
  }

  if (!blank(body.address)) {
    if (typeof body.address !== 'string') return { problem: 'Address is one line of text' };
    const address = oneLine(body.address);
    if (address.length > MAX_ADDRESS) return { problem: `Address can be at most ${MAX_ADDRESS} characters` };
    fields.addresses = [{ label: 'primary', isDefault: true, address }];
  }

  if (!blank(body.staffNotes)) {
    const notes = String(body.staffNotes).trim();
    if (notes.length > MAX_NOTES) return { problem: 'Staff notes are too long' };
    fields.staffNotes = notes;
  }

  return { fields };
}

/** The one-line address a member's record shows: their primary one. */
function primaryAddress(user) {
  const list = (user && Array.isArray(user.addresses) ? user.addresses : []);
  const entry = list.find((a) => a && a.isDefault) || list.find((a) => a && a.label === 'primary') || list[0];
  return (entry && entry.address) || '';
}

module.exports = { profileFieldsFrom, primaryAddress, oneLine };
