const nodemailer = require('nodemailer');
const emailTemplates = require('../templates/emailTemplates');

// Create reusable transporter
let transporter = null;

/**
 * Initialize the email transporter
 */
function initTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  return transporter;
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
    const transport = initTransporter();

    const mailOptions = {
      from: process.env.EMAIL_FROM || `"The Jymor" <${process.env.SMTP_USER}>`,
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
    const transport = initTransporter();
    await transport.verify();
    console.log('✅ SMTP connection verified');
    return true;
  } catch (error) {
    console.error('❌ SMTP connection failed:', error.message);
    return false;
  }
}

module.exports = {
  sendEmail,
  sendOrderEmail,
  sendReturnEmail,
  verifyConnection
};
