// src/services/templateService.js
//
// The list of messages the system sends, what each may say, and the gym's
// own wording for any it has customised (models/messageTemplateModel.js).
//
// Two kinds of text per event: the email (subject + body) and the short
// version that goes by SMS, WhatsApp or push. Both use {{placeholders}} from
// the event's variable list. The built-in emails for transactional events
// live in templates/gymEmails.js and are used unless the gym has enabled an
// override; the automations (absent, win-back, birthday) have their defaults
// here because they are new and plain.

const sanitizeHtml = require('sanitize-html');
const MessageTemplate = require('../models/messageTemplateModel');
const { shell, paragraph, escapeHtml } = require('../templates/gymEmails');

const COMMON = ['firstName', 'siteName', 'portalUrl', 'timetableUrl', 'renewUrl'];

const EVENTS = [
  {
    key: 'member_welcome',
    label: 'Welcome',
    group: 'Members',
    // username: the member-app sign-in, when the gym has the app.
    vars: [...COMMON, 'username'],
    text: '{{siteName}}: welcome, {{firstName}}! Your account is ready — see the timetable and your membership at {{portalUrl}}'
  },
  {
    key: 'booking_confirmed',
    label: 'Class booking confirmed',
    group: 'Classes',
    vars: [...COMMON, 'className', 'date', 'startTime', 'endTime', 'instructorName'],
    text: '{{siteName}}: you are booked into {{className}} on {{date}} at {{startTime}}.'
  },
  {
    key: 'booking_waitlisted',
    label: 'Class full — on the waiting list',
    group: 'Classes',
    vars: [...COMMON, 'className', 'date', 'startTime', 'position'],
    text: '{{siteName}}: {{className}} on {{date}} at {{startTime}} is full — you are number {{position}} on the waiting list.'
  },
  {
    key: 'booking_promoted',
    label: 'A place came free',
    group: 'Classes',
    vars: [...COMMON, 'className', 'date', 'startTime', 'endTime'],
    text: '{{siteName}}: a place opened up — you are now booked into {{className}} on {{date}} at {{startTime}}.'
  },
  {
    key: 'booking_cancelled',
    label: 'Class booking cancelled',
    group: 'Classes',
    vars: [...COMMON, 'className', 'date', 'startTime'],
    text: '{{siteName}}: your booking for {{className}} on {{date}} at {{startTime}} has been cancelled.'
  },
  {
    key: 'class_reminder',
    label: 'Class tomorrow reminder',
    group: 'Classes',
    vars: [...COMMON, 'className', 'date', 'startTime', 'endTime', 'instructorName'],
    text: "{{siteName}}: reminder — {{className}} tomorrow ({{date}}) at {{startTime}}. Can't make it? Cancel in your account so someone else can have the place."
  },
  {
    key: 'membership_confirmed',
    label: 'Membership active',
    group: 'Memberships',
    vars: [...COMMON, 'packageName', 'startDate', 'endDate', 'amount', 'currency', 'orderNumber'],
    text: '{{siteName}}: your {{packageName}} membership is active until {{endDate}}. Order {{orderNumber}}.'
  },
  {
    key: 'membership_renewed',
    label: 'Membership renewed',
    group: 'Memberships',
    vars: [...COMMON, 'packageName', 'endDate', 'amount', 'currency'],
    text: '{{siteName}}: your {{packageName}} membership has renewed and now runs until {{endDate}}.'
  },
  {
    key: 'membership_expiring',
    label: 'Membership about to end',
    group: 'Memberships',
    vars: [...COMMON, 'packageName', 'endDate', 'daysLeft'],
    text: '{{siteName}}: your {{packageName}} membership ends on {{endDate}} ({{daysLeft}} day(s) left). Renew: {{renewUrl}}'
  },
  {
    key: 'membership_expired',
    label: 'Membership ended',
    group: 'Memberships',
    vars: [...COMMON, 'packageName', 'endDate'],
    text: '{{siteName}}: your {{packageName}} membership ended on {{endDate}}. Renew any time: {{renewUrl}}'
  },
  {
    key: 'payment_failed',
    label: 'Card payment failed',
    group: 'Payments',
    vars: [...COMMON, 'packageName', 'endDate', 'reason'],
    text: '{{siteName}}: a payment for your {{packageName}} membership failed. {{reason}} Please update your card: {{portalUrl}}'
  },
  {
    key: 'transfer_received',
    label: 'Bank transfer proof received',
    group: 'Payments',
    vars: [...COMMON, 'packageName', 'amount', 'currency', 'orderNumber'],
    text: '{{siteName}}: we received your transfer proof for order {{orderNumber}} ({{currency}} {{amount}}). We will confirm once it clears.'
  },
  {
    key: 'transfer_rejected',
    label: 'Bank transfer proof rejected',
    group: 'Payments',
    vars: [...COMMON, 'packageName', 'orderNumber', 'reason'],
    text: '{{siteName}}: we could not accept the transfer proof for order {{orderNumber}}. {{reason}} Please try again: {{renewUrl}}'
  },
  {
    key: 'membership_frozen',
    label: 'Membership frozen',
    group: 'Memberships',
    vars: [...COMMON, 'packageName', 'resumeAt', 'endDate'],
    text: '{{siteName}}: your {{packageName}} membership is frozen until {{resumeAt}} and now runs until {{endDate}}.'
  },
  {
    key: 'membership_cancelled',
    label: 'Membership cancelled',
    group: 'Memberships',
    vars: [...COMMON, 'packageName', 'endDate'],
    text: '{{siteName}}: your {{packageName}} membership has been cancelled. You are welcome back any time: {{renewUrl}}'
  },
  {
    key: 'pt_booked',
    label: 'Personal training session booked',
    group: 'Personal training',
    vars: [...COMMON, 'trainerName', 'date', 'startTime', 'endTime'],
    subject: 'Your session with {{trainerName}} is booked',
    body: 'Hi {{firstName}},\n\nYou are booked with {{trainerName}} on {{date}} at {{startTime}}.\n\nNeed to change it? Manage your sessions at {{portalUrl}}',
    text: '{{siteName}}: PT with {{trainerName}} booked for {{date}} at {{startTime}}.'
  },
  {
    key: 'pt_cancelled',
    label: 'Personal training session cancelled',
    group: 'Personal training',
    vars: [...COMMON, 'trainerName', 'date', 'startTime', 'reason'],
    subject: 'Your session with {{trainerName}} was cancelled',
    body: 'Hi {{firstName}},\n\nYour session with {{trainerName}} on {{date}} at {{startTime}} has been cancelled. {{reason}}\n\nBook another at {{portalUrl}}',
    text: '{{siteName}}: your PT session with {{trainerName}} on {{date}} at {{startTime}} was cancelled. {{reason}}'
  },
  {
    key: 'pt_reminder',
    label: 'Personal training session tomorrow',
    group: 'Personal training',
    vars: [...COMMON, 'trainerName', 'date', 'startTime', 'endTime'],
    subject: 'Tomorrow: your session with {{trainerName}}',
    body: 'Hi {{firstName}},\n\nA reminder that you are training with {{trainerName}} tomorrow ({{date}}) at {{startTime}}.\n\nCan\'t make it? Cancel in time at {{portalUrl}} so the slot can go to someone else.',
    text: '{{siteName}}: reminder — PT with {{trainerName}} tomorrow at {{startTime}}.'
  },
  {
    key: 'absent_nudge',
    label: 'We miss you (no visit for a while)',
    group: 'Automations',
    vars: [...COMMON, 'daysAbsent'],
    subject: 'We miss you at {{siteName}}',
    body:
      'Hi {{firstName}},\n\nIt has been {{daysAbsent}} days since your last visit and your membership is still active — the timetable is waiting for you.\n\nSee this week\'s classes: {{timetableUrl}}',
    text: '{{siteName}}: we miss you, {{firstName}}! It has been {{daysAbsent}} days — come back this week: {{timetableUrl}}'
  },
  {
    key: 'win_back',
    label: 'Win back a lapsed member',
    group: 'Automations',
    vars: [...COMMON, 'packageName', 'endDate'],
    subject: 'Come back to {{siteName}}',
    body:
      'Hi {{firstName}},\n\nYour {{packageName}} membership ended on {{endDate}} and we would love to have you back.\n\nRejoin here: {{renewUrl}}',
    text: '{{siteName}}: we would love to have you back, {{firstName}}. Rejoin: {{renewUrl}}'
  },
  {
    key: 'birthday',
    label: 'Birthday greeting',
    group: 'Automations',
    vars: [...COMMON],
    subject: 'Happy birthday from {{siteName}}!',
    body: 'Happy birthday, {{firstName}}!\n\nEveryone at {{siteName}} wishes you a great day — come and celebrate with a workout.',
    text: '{{siteName}}: happy birthday, {{firstName}}! Have a great day.'
  }
];

const BY_KEY = new Map(EVENTS.map((e) => [e.key, e]));

function isEvent(key) {
  return BY_KEY.has(key);
}

/** {{name}} -> value. Unknown names become empty rather than staying visible. */
function fill(template, vars, escape) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => {
    const value = vars[name];
    const text = value === undefined || value === null ? '' : String(value);
    return escape ? escapeHtml(text) : text;
  });
}

const HTML_TAGS = ['p', 'br', 'a', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'blockquote', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img'];

/**
 * A body as typed by an admin, into email HTML. Plain text keeps its
 * paragraphs; HTML is allowed but cleaned. Placeholders are filled first
 * (escaped, so a member called "<b>" cannot restyle the email) and URLs
 * become links.
 */
function bodyToHtml(body, vars) {
  const filled = fill(body, vars, true);
  const looksLikeHtml = /<\s*(p|div|br|ul|ol|table|h[1-3])\b/i.test(filled);
  let html;
  if (looksLikeHtml) {
    html = filled;
  } else {
    html = filled
      .split(/\n\s*\n/)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => paragraph(chunk.replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#18181b">$1</a>')))
      .join('');
  }
  return sanitizeHtml(html, {
    allowedTags: HTML_TAGS,
    allowedAttributes: { a: ['href', 'target', 'style'], img: ['src', 'alt', 'width', 'height', 'style'], '*': ['style'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel']
  });
}

async function overrideFor(key) {
  try {
    return await MessageTemplate.findOne({ key }).lean();
  } catch {
    return null;
  }
}

/**
 * The email for an event, if the gym has its own wording (or the event only
 * exists here). Null means "use the built-in email".
 */
async function renderEmail(key, vars = {}) {
  const event = BY_KEY.get(key);
  if (!event) return null;
  const custom = await overrideFor(key);
  const use = custom && custom.enabled && custom.subject && custom.body ? custom : event.subject && event.body ? event : null;
  if (!use) return null;
  const subject = fill(use.subject, vars, false);
  return {
    subject,
    html: shell(vars.siteName || 'GymsPilotPro', subject, bodyToHtml(use.body, vars)),
    custom: use === custom
  };
}

/** The short text for SMS / WhatsApp / push. */
async function renderText(key, vars = {}) {
  const event = BY_KEY.get(key);
  if (!event) return '';
  const custom = await overrideFor(key);
  const template = custom && custom.enabled && custom.text ? custom.text : event.text;
  return fill(template, vars, false).replace(/\s+/g, ' ').trim();
}

/** Example values for previews and test sends. */
function sampleVars(siteName = 'GymsPilotPro', origin = 'https://example.com') {
  return {
    firstName: 'Alex',
    username: 'alex.smith',
    siteName,
    portalUrl: `${origin}/user-detail`,
    timetableUrl: `${origin}/classes`,
    renewUrl: `${origin}/packages`,
    className: 'Morning Spin',
    date: '12 September 2026',
    startTime: '07:00',
    endTime: '07:45',
    instructorName: 'Sam',
    position: 2,
    packageName: 'Monthly Unlimited',
    startDate: '1 September 2026',
    endDate: '30 September 2026',
    daysLeft: 7,
    amount: '49.00',
    currency: 'USD',
    orderNumber: 'ORD-000123',
    reason: 'Your card was declined.',
    resumeAt: '20 September 2026',
    daysAbsent: 14
  };
}

/** Every event with the gym's override (if any) merged in, for the admin screen. */
async function list() {
  const overrides = await MessageTemplate.find({}).lean();
  const byKey = new Map(overrides.map((o) => [o.key, o]));
  return EVENTS.map((event) => {
    const custom = byKey.get(event.key) || null;
    return {
      key: event.key,
      label: event.label,
      group: event.group,
      variables: event.vars,
      default_subject: event.subject || '',
      default_body: event.body || '',
      default_text: event.text,
      built_in_email: !event.subject,
      custom: custom
        ? { subject: custom.subject, body: custom.body, text: custom.text, enabled: custom.enabled, updated_at: custom.updatedAt }
        : null
    };
  });
}

module.exports = {
  EVENTS,
  isEvent,
  fill,
  bodyToHtml,
  renderEmail,
  renderText,
  sampleVars,
  list
};
