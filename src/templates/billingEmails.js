// src/templates/billingEmails.js
//
// The renewal-billing emails (services/billing/billingMessages.js): the
// payment link before the due date, on it, after a saved card was declined,
// on the last day to pay, and the one staff send by hand.
//
// The gym is the sender and its name leads -- in the header, the title and
// the table -- because the member pays the gym, straight into its own
// account; GymsPilotPro is named once, in the footer. Every value that came
// from a person or the gym's settings is escaped (gymEmails.escapeHtml).
// Each returns { subject, html }, as the rest of templates/ do.

const { shell, escapeHtml, paragraph, button, detailTable, callout } = require('./gymEmails');

const KINDS = ['before', 'due', 'declined', 'last', 'link'];

function subjectFor(kind, { siteName, dueDate }) {
  switch (kind) {
    case 'before':
      return `${siteName}: your renewal is due on ${dueDate}`;
    case 'due':
      return `${siteName}: your renewal is due today`;
    case 'declined':
      return `${siteName}: we could not charge your saved card`;
    case 'last':
      return `${siteName}: today is the last day to pay your renewal`;
    default:
      return `${siteName}: your payment link`;
  }
}

function opening(kind, v) {
  const name = escapeHtml(v.firstName || 'there');
  const pkg = `<strong>${escapeHtml(v.packageName || 'membership')}</strong>`;
  switch (kind) {
    case 'before':
      return `Hi ${name}, your ${pkg} renewal at ${escapeHtml(v.siteName)} is due on <strong>${escapeHtml(v.dueDate)}</strong>.`;
    case 'due':
      return `Hi ${name}, your ${pkg} renewal at ${escapeHtml(v.siteName)} is due today.`;
    case 'declined':
      return `Hi ${name}, we tried to take your ${pkg} renewal from your saved card today, but the payment did not go through.`;
    case 'last':
      return `Hi ${name}, today is the last day to pay your ${pkg} renewal at ${escapeHtml(v.siteName)}.`;
    default:
      return `Hi ${name}, here is the payment link for your ${pkg} at ${escapeHtml(v.siteName)}.`;
  }
}

function bankBlock(banks, online) {
  if (!banks || !banks.length) return '';
  const rows = banks.map((bank) =>
    detailTable([
      ['Bank', bank.name],
      ['Account title', bank.accountTitle],
      ['Account number', bank.accountNumber],
      ['IBAN (Raast)', bank.iban],
      ['Branch', bank.branch]
    ])
  );
  return [
    paragraph(
      online
        ? '<strong>Prefer a bank transfer?</strong> Send it from any bank app by Raast or IBFT, with no fee, to:'
        : '<strong>Pay by bank transfer</strong> from any bank app by Raast or IBFT, with no fee, to:'
    ),
    ...rows,
    paragraph('Use your name as the reference, then upload a screenshot of the receipt on the payment page and the gym will confirm it.')
  ].join('');
}

/**
 * @param {string} kind  before | due | declined | last | link
 * @param {object} v     siteName, firstName, packageName, period, amount, currency,
 *                       dueDate, lastDay, payUrl, orderNumber, reason,
 *                       onlineLabel (null: no online payment), banks,
 *                       autoPayCard ("Visa •••• 4242" when it will be charged)
 */
function billingEmail(kind, v) {
  const online = !!v.onlineLabel;
  const amount = `${v.currency || ''} ${v.amount || ''}`.trim();
  const body = [
    paragraph(opening(kind, v)),
    kind === 'declined'
      ? callout(`${escapeHtml(v.reason || 'Your card was declined.')} Your membership is not paid yet: please pay by ${escapeHtml(v.lastDay)} to keep it going.`, 'bad')
      : '',
    kind === 'last' ? callout('After today your membership lapses until it is renewed.', 'warn') : '',
    detailTable([
      ['Gym', v.siteName],
      ['Package', v.packageName],
      ['Period', v.period],
      ['Amount', amount],
      ['Due date', v.dueDate],
      ['Last day to pay', v.lastDay],
      ['Reference', v.orderNumber]
    ]),
    kind === 'before' && v.autoPayCard
      ? callout(`Nothing to do: we will charge your saved card ${escapeHtml(v.autoPayCard)} on the due date. You can still pay now, or switch automatic payments off in your account.`, 'good')
      : '',
    online ? paragraph(`Pay online in a minute: ${escapeHtml(v.onlineLabel)}.`) : '',
    v.payUrl ? `<p style="margin:0 0 20px">${button(v.payUrl, online ? 'Pay now' : v.banks && v.banks.length ? 'Pay by bank transfer' : 'See how to pay')}</p>` : '',
    bankBlock(v.banks, online)
  ].join('');

  const siteName = v.siteName || 'your gym';
  const footer =
    `You are receiving this because you are a member of ${escapeHtml(siteName)}. ` +
    `Payments go straight to ${escapeHtml(siteName)}. Sent with GymsPilotPro.`;
  const subject = subjectFor(kind, { siteName, dueDate: v.dueDate });
  return { subject, html: shell(siteName, subject, body, footer) };
}

module.exports = { KINDS, billingEmail, subjectFor };
