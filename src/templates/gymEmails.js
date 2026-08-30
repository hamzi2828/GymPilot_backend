// src/templates/gymEmails.js
//
// The emails a gym actually sends.
//
// Kept separate from emailTemplates.js, which is the inherited e-commerce set
// (order shipped, return approved, preorder back in stock) and speaks about
// parcels and refunds. None of it applies to a membership, and rather than
// bend those templates into something they are not, this file starts from what
// a gym has to say: your membership is live, it runs out on Friday, you are
// booked into Tuesday's class, your place came free.
//
// Every function returns { subject, html } so callers hand them to sendEmail
// the same way throughout.

const BRAND_FALLBACK = 'GymPilot';

/* ------------------------------- chrome -------------------------------- */

function shell(siteName, title, bodyHtml, footerNote) {
  return `
  <div style="margin:0;padding:24px;background:#f4f4f5">
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden">
      <div style="padding:20px 28px;background:#18181b">
        <span style="color:#ffffff;font-size:15px;font-weight:700;letter-spacing:0.02em">${escapeHtml(siteName)}</span>
      </div>
      <div style="padding:28px">
        <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#18181b">${escapeHtml(title)}</h1>
        ${bodyHtml}
      </div>
      <div style="padding:16px 28px;border-top:1px solid #f4f4f5">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#a1a1aa">
          ${footerNote || `You are receiving this because you have an account with ${escapeHtml(siteName)}.`}
        </p>
      </div>
    </div>
  </div>`;
}

// Member-supplied values (names, class names, package names) end up in these
// templates, so they are escaped rather than trusted. A member called
// "<script>" should not be able to reshape an email the gym sends.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paragraph(text) {
  return `<p style="margin:0 0 16px;line-height:1.65;color:#3f3f46;font-size:14px">${text}</p>`;
}

function button(href, label) {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px">${escapeHtml(label)}</a>`;
}

/** A key/value block — the shape most of these emails need. */
function detailTable(rows) {
  const cells = rows
    .filter((row) => row && row[1] !== undefined && row[1] !== null && row[1] !== '')
    .map(
      ([label, value], i, all) => `
      <tr>
        <td style="padding:11px 16px;${i < all.length - 1 ? 'border-bottom:1px solid #e4e4e7;' : ''}color:#71717a;font-size:13px">${escapeHtml(label)}</td>
        <td style="padding:11px 16px;${i < all.length - 1 ? 'border-bottom:1px solid #e4e4e7;' : ''}font-weight:600;color:#18181b;font-size:13px;text-align:right">${escapeHtml(value)}</td>
      </tr>`
    )
    .join('');

  return `<table style="width:100%;border-collapse:collapse;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;margin:0 0 20px">${cells}</table>`;
}

function callout(text, tone = 'warn') {
  const palette =
    tone === 'bad'
      ? { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b' }
      : tone === 'good'
      ? { bg: '#f0fdf4', border: '#bbf7d0', fg: '#166534' }
      : { bg: '#fffbeb', border: '#fde68a', fg: '#92400e' };

  return `<div style="margin:0 0 20px;padding:12px 16px;background:${palette.bg};border:1px solid ${palette.border};border-radius:8px;color:${palette.fg};font-size:13px;line-height:1.6">${text}</div>`;
}

function dateLabel(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* ---------------------------- membership ------------------------------- */

function membershipConfirmed({ firstName, packageName, startDate, endDate, amount, currency, orderNumber, siteName = BRAND_FALLBACK, portalUrl }) {
  const body = [
    paragraph(`Hi ${escapeHtml(firstName || 'there')}, your membership is active. Here are the details:`),
    detailTable([
      ['Package', packageName],
      ['Starts', dateLabel(startDate)],
      ['Runs until', dateLabel(endDate)],
      ['Paid', amount ? `${currency || ''} ${amount}`.trim() : ''],
      ['Reference', orderNumber]
    ]),
    paragraph('You can check your membership, book classes and see your visit history any time.'),
    portalUrl ? button(portalUrl, 'Open my account') : ''
  ].join('');

  return {
    subject: `Your ${siteName} membership is active`,
    html: shell(siteName, 'Membership confirmed', body)
  };
}

function membershipExpiring({ firstName, packageName, endDate, daysLeft, siteName = BRAND_FALLBACK, renewUrl }) {
  const when =
    daysLeft <= 0
      ? 'today'
      : daysLeft === 1
      ? 'tomorrow'
      : `in ${daysLeft} days`;

  const body = [
    paragraph(`Hi ${escapeHtml(firstName || 'there')}, your membership runs out ${escapeHtml(when)}.`),
    detailTable([
      ['Package', packageName],
      ['Last day', dateLabel(endDate)]
    ]),
    callout('Renew before it lapses and you keep your class bookings and your visit streak.'),
    renewUrl ? button(renewUrl, 'Renew my membership') : ''
  ].join('');

  return {
    subject: `Your ${siteName} membership ends ${when}`,
    html: shell(siteName, 'Your membership is about to end', body)
  };
}

function membershipExpired({ firstName, packageName, endDate, siteName = BRAND_FALLBACK, renewUrl }) {
  const body = [
    paragraph(`Hi ${escapeHtml(firstName || 'there')}, your membership has now ended.`),
    detailTable([
      ['Package', packageName],
      ['Ended', dateLabel(endDate)]
    ]),
    callout('You are welcome to come back any time — pick up where you left off.', 'bad'),
    renewUrl ? button(renewUrl, 'Rejoin') : ''
  ].join('');

  return {
    subject: `Your ${siteName} membership has ended`,
    html: shell(siteName, 'Membership ended', body)
  };
}

/* ------------------------------ bookings ------------------------------- */

function bookingConfirmed({ firstName, className, date, startTime, endTime, instructorName, siteName = BRAND_FALLBACK, portalUrl }) {
  const body = [
    paragraph(`Hi ${escapeHtml(firstName || 'there')}, your place is booked.`),
    detailTable([
      ['Class', className],
      ['Date', dateLabel(date)],
      ['Time', endTime ? `${startTime}–${endTime}` : startTime],
      ['With', instructorName]
    ]),
    paragraph('If you cannot make it, please cancel so somebody on the waiting list can take your place.'),
    portalUrl ? button(portalUrl, 'My classes') : ''
  ].join('');

  return {
    subject: `Booked: ${className} on ${dateLabel(date)}`,
    html: shell(siteName, 'You are booked in', body)
  };
}

function bookingWaitlisted({ firstName, className, date, startTime, position, siteName = BRAND_FALLBACK, portalUrl }) {
  const body = [
    paragraph(`Hi ${escapeHtml(firstName || 'there')}, that class is full — you are on the waiting list.`),
    detailTable([
      ['Class', className],
      ['Date', dateLabel(date)],
      ['Time', startTime],
      ['Your position', `#${position}`]
    ]),
    callout('If somebody cancels you are moved up automatically and we will email you.'),
    portalUrl ? button(portalUrl, 'My classes') : ''
  ].join('');

  return {
    subject: `Waiting list: ${className} on ${dateLabel(date)}`,
    html: shell(siteName, 'You are on the waiting list', body)
  };
}

function bookingPromoted({ firstName, className, date, startTime, endTime, siteName = BRAND_FALLBACK, portalUrl }) {
  const body = [
    paragraph(`Good news ${escapeHtml(firstName || 'there')} — a place came free and it is yours.`),
    detailTable([
      ['Class', className],
      ['Date', dateLabel(date)],
      ['Time', endTime ? `${startTime}–${endTime}` : startTime]
    ]),
    callout('You are booked in. Nothing else to do — just turn up.', 'good'),
    portalUrl ? button(portalUrl, 'My classes') : ''
  ].join('');

  return {
    subject: `You're in: ${className} on ${dateLabel(date)}`,
    html: shell(siteName, 'A place came free', body)
  };
}

function bookingCancelled({ firstName, className, date, startTime, byStaff, siteName = BRAND_FALLBACK, portalUrl }) {
  const body = [
    paragraph(
      byStaff
        ? `Hi ${escapeHtml(firstName || 'there')}, your booking has been cancelled by the gym.`
        : `Hi ${escapeHtml(firstName || 'there')}, your booking is cancelled.`
    ),
    detailTable([
      ['Class', className],
      ['Date', dateLabel(date)],
      ['Time', startTime]
    ]),
    portalUrl ? button(portalUrl, 'Book another class') : ''
  ].join('');

  return {
    subject: `Cancelled: ${className} on ${dateLabel(date)}`,
    html: shell(siteName, 'Booking cancelled', body)
  };
}

function classReminder({ firstName, className, date, startTime, endTime, instructorName, siteName = BRAND_FALLBACK, portalUrl }) {
  const body = [
    paragraph(`Hi ${escapeHtml(firstName || 'there')}, this is a reminder about tomorrow's class.`),
    detailTable([
      ['Class', className],
      ['Date', dateLabel(date)],
      ['Time', endTime ? `${startTime}–${endTime}` : startTime],
      ['With', instructorName]
    ]),
    paragraph('Cannot make it? Cancel now and free the place up for somebody else.'),
    portalUrl ? button(portalUrl, 'My classes') : ''
  ].join('');

  return {
    subject: `Tomorrow: ${className} at ${startTime}`,
    html: shell(siteName, 'See you tomorrow', body)
  };
}

/* ------------------------------- welcome -------------------------------- */

function memberWelcome({ firstName, siteName = BRAND_FALLBACK, portalUrl, timetableUrl }) {
  const body = [
    paragraph(`Welcome ${escapeHtml(firstName || 'aboard')} — your account is ready.`),
    paragraph('Here is what you can do from here:'),
    `<ul style="margin:0 0 20px;padding-left:20px;color:#3f3f46;font-size:14px;line-height:1.8">
       <li>Book classes from the timetable</li>
       <li>See your membership and when it runs out</li>
       <li>Look back at every visit you have made</li>
     </ul>`,
    timetableUrl ? button(timetableUrl, 'Book your first class') : portalUrl ? button(portalUrl, 'Open my account') : ''
  ].join('');

  return {
    subject: `Welcome to ${siteName}`,
    html: shell(siteName, `Welcome to ${siteName}`, body)
  };
}

module.exports = {
  // exported for reuse and for tests
  shell,
  escapeHtml,
  detailTable,
  callout,
  dateLabel,

  membershipConfirmed,
  membershipExpiring,
  membershipExpired,
  bookingConfirmed,
  bookingWaitlisted,
  bookingPromoted,
  bookingCancelled,
  classReminder,
  memberWelcome
};
