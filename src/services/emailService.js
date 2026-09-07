const nodemailer = require('nodemailer');

// Reusable transporters, one per distinct SMTP configuration. Keyed by a
// fingerprint of the config rather than by gym, so a credential change in a
// gym's admin panel takes effect without a redeploy, and gyms that share
// nothing do not keep rebuilding each other's transport.
const transporters = new Map(); // config fingerprint -> transporter
const MAX_TRANSPORTERS = 100;

/**
 * Resolves SMTP config, preferring the admin-managed settings document and
 * falling back to environment variables when it has not been configured.
 */
async function resolveSmtpConfig() {
  try {
    const Settings = require('../models/settings');
    const settings = await Settings.getSettings();
    const s = settings && settings.smtp;
    if (s && s.host && s.user && s.pass) {
      return {
        host: s.host,
        port: Number(s.port) || 587,
        secure: s.secure !== undefined ? !!s.secure : Number(s.port) === 465,
        user: s.user,
        pass: s.pass,
        from:
          s.fromEmail
            ? `"${s.fromName || process.env.SITE_NAME || 'GymPilot'}" <${s.fromEmail}>`
            : null,
      };
    }
  } catch {
    // Settings unavailable (e.g. no DB connection yet) — fall back to env.
  }
  return {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_PORT === '465',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM || null,
  };
}

/**
 * Initialize the email transporter
 */
async function initTransporter() {
  const cfg = await resolveSmtpConfig();
  const key = `${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}|${cfg.pass}`;

  let transporter = transporters.get(key);
  if (transporter) return { transport: transporter, cfg };

  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  // Bounded: drop the oldest entry rather than grow with every config ever
  // seen on a long-lived process.
  if (transporters.size >= MAX_TRANSPORTERS) {
    transporters.delete(transporters.keys().next().value);
  }
  transporters.set(key, transporter);

  return { transport: transporter, cfg };
}

/**
 * Send an email
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} html - Email HTML content
 * @returns {Promise<object>} - Send result
 */
async function sendEmail(to, subject, html, options = {}) {
  try {
    const { transport, cfg } = await initTransporter();

    const mailOptions = {
      from: cfg.from || `"${process.env.SITE_NAME || 'GymPilot'}" <${cfg.user}>`,
      to,
      subject,
      html,
      // e.g. an invoice PDF: [{ filename, content (Buffer), contentType }]
      ...(Array.isArray(options.attachments) && options.attachments.length ? { attachments: options.attachments } : {})
    };

    const result = await transport.sendMail(mailOptions);
    console.log(`✉️ Email sent to ${to}: ${subject}`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

// sendOrderEmail() and sendReturnEmail() used to live here.
//
// They dispatched the inherited e-commerce templates -- order shipped, return
// approved, preorder back in stock -- none of which a gym ever sends. Their
// only callers were the product order and payment controllers, which are gone.
// Gym email is built and sent through services/gymNotifications.js instead.

/**
 * Verify SMTP connection
 * @returns {Promise<boolean>} - True if connection is valid
 */
async function verifyConnection() {
  try {
    const { transport } = await initTransporter();
    await transport.verify();
    console.log('✅ SMTP connection verified');
    return { ok: true };
  } catch (error) {
    console.error('❌ SMTP connection failed:', error.message);
    return { ok: false, error: error.message };
  }
}

module.exports = {
  sendEmail,
  verifyConnection
};
