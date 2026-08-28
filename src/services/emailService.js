const nodemailer = require('nodemailer');
const emailTemplates = require('../templates/emailTemplates');

// Create reusable transporter
let transporter = null;
// Fingerprint of the config the cached transporter was built from, so a
// credential change in the admin panel takes effect without a redeploy.
let transporterKey = null;

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
            ? `"${s.fromName || 'The Jymor'}" <${s.fromEmail}>`
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

  if (transporter && transporterKey === key) return { transport: transporter, cfg };

  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  transporterKey = key;

  return { transport: transporter, cfg };
}

/**
 * Send an email
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} html - Email HTML content
 * @returns {Promise<object>} - Send result
 */
async function sendEmail(to, subject, html) {
  try {
    const { transport, cfg } = await initTransporter();

    const mailOptions = {
      from: cfg.from || `"The Jymor" <${cfg.user}>`,
      to,
      subject,
      html
    };

    const result = await transport.sendMail(mailOptions);
    console.log(`✉️ Email sent to ${to}: ${subject}`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send order-related email
 * @param {object} order - The order object (should be populated)
 * @param {string} templateType - Type of email template to use
 * @returns {Promise<object>} - Send result
 */
async function sendOrderEmail(order, templateType) {
  try {
    const email = order.shippingAddress?.email;
    if (!email) {
      console.warn('⚠️ No email address found for order:', order.orderNumber);
      return { success: false, error: 'No email address found' };
    }

    const templateFn = emailTemplates[templateType];
    if (!templateFn) {
      console.error(`❌ Unknown email template: ${templateType}`);
      return { success: false, error: `Unknown template: ${templateType}` };
    }

    const { subject, html } = templateFn(order);
    return await sendEmail(email, subject, html);
  } catch (error) {
    console.error(`❌ Error sending order email (${templateType}):`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send return-related email
 * @param {object} returnOrder - The return order object (should be populated with order)
 * @param {object} order - The original order object
 * @param {string} templateType - Type of email template to use
 * @returns {Promise<object>} - Send result
 */
async function sendReturnEmail(returnOrder, order, templateType) {
  try {
    const email = order?.shippingAddress?.email;
    if (!email) {
      console.warn('⚠️ No email address found for return:', returnOrder.returnNumber);
      return { success: false, error: 'No email address found' };
    }

    const templateFn = emailTemplates[templateType];
    if (!templateFn) {
      console.error(`❌ Unknown email template: ${templateType}`);
      return { success: false, error: `Unknown template: ${templateType}` };
    }

    const { subject, html } = templateFn(returnOrder, order);
    return await sendEmail(email, subject, html);
  } catch (error) {
    console.error(`❌ Error sending return email (${templateType}):`, error.message);
    return { success: false, error: error.message };
  }
}

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
  sendOrderEmail,
  sendReturnEmail,
  verifyConnection
};
