// src/services/invoiceService.js
//
// One invoice per paid membership order: a gap-free number from the gym's
// own sequence, the tax breakdown from its Settings, and a PDF built on
// demand from what is stored on the order -- so the document a member
// downloads in a year is the one they were sent, not a re-rendering of
// whatever the package costs by then.
//
// Prices are treated as tax-INCLUSIVE: the amount charged is the price the
// member saw, and the invoice shows how much of that was tax. That is how
// gyms price memberships, and it means a card payment already taken never
// has tax added on top after the fact.

const PDFDocument = require('pdfkit');
const Counter = require('../gymfolio/models/counterModel');
const Settings = require('../models/settings');
const { currentTenant } = require('../platform/tenantContext');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function money(amount, currency) {
  const code = String(currency || '').toUpperCase();
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code || 'USD' }).format(Number(amount) || 0);
  } catch {
    return `${code} ${round2(amount).toFixed(2)}`;
  }
}

function dateLabel(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Assigns an invoice number and tax breakdown to a paid order if it has none.
 * Idempotent: an order keeps its first number for life.
 */
async function ensureInvoice(order) {
  if (order.invoice && order.invoice.number) return order.invoice;

  const settings = await Settings.getSettings().catch(() => null);
  const inv = (settings && settings.invoice) || {};
  const prefix = (inv.prefix || 'INV').toUpperCase();
  const taxRate = Math.max(0, Number((settings && settings.taxRate) || 0));

  const total = round2(order.payment && order.payment.amount);
  const taxAmount = taxRate > 0 ? round2(total - total / (1 + taxRate / 100)) : 0;

  const year = new Date().getFullYear();
  const seq = await Counter.next(`invoice-${year}`);
  const number = `${prefix}-${year}-${String(seq).padStart(4, '0')}`;

  order.invoice = {
    number,
    issuedAt: new Date(),
    taxRate,
    taxLabel: inv.taxLabel || 'Tax',
    taxAmount,
    subtotal: round2(total - taxAmount),
    total,
    currency: String((order.payment && order.payment.currency) || '').toUpperCase()
  };
  await order.save();
  return order.invoice;
}

/**
 * Renders the invoice as a PDF buffer.
 *
 * @param {object} order   a PackageOrder (with invoice assigned)
 * @param {object} [options]
 * @param {object} [options.settings]  Settings document (fetched if absent)
 * @returns {Promise<Buffer>}
 */
async function renderInvoicePdf(order, options = {}) {
  const settings = options.settings || (await Settings.getSettings().catch(() => null)) || {};
  const gym = currentTenant();
  const invoice = order.invoice || {};
  const inv = settings.invoice || {};
  const currency = invoice.currency || String((order.payment && order.payment.currency) || '').toUpperCase();
  const pkg = order.packageDetails || {};
  const customer = order.customerInfo || {};
  const payment = order.payment || {};
  const sub = order.subscription || {};

  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${invoice.number || ''}` } });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const dark = '#18181b';
  const muted = '#71717a';
  const line = '#e4e4e7';
  const left = 50;
  const right = 545;

  // Header
  doc.fillColor(dark).fontSize(20).font('Helvetica-Bold').text(settings.siteName || (gym && gym.name) || 'Invoice', left, 50);
  doc.fontSize(9).font('Helvetica').fillColor(muted);
  const headerLines = [settings.address, settings.mobileNumber, inv.taxNumber ? `${inv.taxLabel || 'Tax'} no. ${inv.taxNumber}` : ''].filter(Boolean);
  headerLines.forEach((text, i) => doc.text(text, left, 76 + i * 12));

  doc.fillColor(dark).fontSize(22).font('Helvetica-Bold').text('INVOICE', 350, 50, { width: 195, align: 'right' });
  doc.fontSize(9).font('Helvetica').fillColor(muted);
  doc.text(`Invoice no. ${invoice.number || '-'}`, 350, 80, { width: 195, align: 'right' });
  doc.text(`Date ${dateLabel(invoice.issuedAt || payment.paidAt || order.createdAt)}`, 350, 92, { width: 195, align: 'right' });
  doc.text(`Order ${order.orderNumber || ''}`, 350, 104, { width: 195, align: 'right' });

  // Bill to
  let y = 140;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(line).stroke();
  y += 14;
  doc.fillColor(muted).fontSize(8).font('Helvetica-Bold').text('BILLED TO', left, y);
  doc.fillColor(dark).fontSize(10).font('Helvetica').text(customer.fullName || customer.email || '', left, y + 12);
  [customer.email, customer.phone, [customer.address, customer.city, customer.state, customer.zipCode, customer.country].filter(Boolean).join(', ')]
    .filter(Boolean)
    .forEach((text, i) => doc.fillColor(muted).fontSize(9).text(text, left, y + 26 + i * 12));

  doc.fillColor(muted).fontSize(8).font('Helvetica-Bold').text('PAYMENT', 350, y, { width: 195, align: 'right' });
  doc.fillColor(dark).fontSize(10).font('Helvetica').text(
    `${(payment.method || '').replace('_', ' ')} · ${payment.status || ''}`.trim(),
    350,
    y + 12,
    { width: 195, align: 'right' }
  );
  if (payment.paidAt) doc.fillColor(muted).fontSize(9).text(`Paid ${dateLabel(payment.paidAt)}`, 350, y + 26, { width: 195, align: 'right' });
  if (payment.transactionId) doc.fillColor(muted).fontSize(8).text(String(payment.transactionId), 350, y + 38, { width: 195, align: 'right' });

  // Line items
  y = 230;
  doc.rect(left, y, right - left, 22).fill('#f4f4f5');
  doc.fillColor(muted).fontSize(8).font('Helvetica-Bold');
  doc.text('DESCRIPTION', left + 10, y + 7);
  doc.text('PERIOD', 300, y + 7);
  doc.text('AMOUNT', 445, y + 7, { width: 90, align: 'right' });
  y += 30;

  const subtotal = invoice.subtotal !== undefined ? invoice.subtotal : round2(payment.amount);
  const listPrice = payment.subtotal !== undefined && payment.subtotal !== null ? round2(payment.subtotal) : round2(payment.amount);
  const discount = round2(payment.discountAmount || 0);

  doc.fillColor(dark).fontSize(10).font('Helvetica').text(`${pkg.name || 'Membership'}${pkg.kind && pkg.kind !== 'membership' ? ` (${String(pkg.kind).replace('_', ' ')})` : ''}`, left + 10, y);
  doc.fillColor(muted).fontSize(9).text(pkg.period ? `per ${pkg.period}` : '', left + 10, y + 13);
  const period = sub.startDate && sub.endDate ? `${dateLabel(sub.startDate)} – ${dateLabel(sub.endDate)}` : '';
  doc.fillColor(dark).fontSize(9).text(period, 300, y, { width: 140 });
  doc.fillColor(dark).fontSize(10).text(money(listPrice, currency), 445, y, { width: 90, align: 'right' });
  y += 34;

  if (discount > 0) {
    doc.fillColor(dark).fontSize(10).text(`Discount${payment.couponCode ? ` (${payment.couponCode})` : ''}`, left + 10, y);
    doc.text(`-${money(discount, currency)}`, 445, y, { width: 90, align: 'right' });
    y += 20;
  }

  doc.moveTo(left, y).lineTo(right, y).strokeColor(line).stroke();
  y += 12;

  const totals = [];
  if (invoice.taxRate > 0) {
    totals.push([`Subtotal (excl. ${invoice.taxLabel || 'tax'})`, money(subtotal, currency)]);
    totals.push([`${invoice.taxLabel || 'Tax'} ${invoice.taxRate}% (included)`, money(invoice.taxAmount, currency)]);
  }
  totals.push(['Total paid', money(invoice.total !== undefined ? invoice.total : payment.amount, currency)]);
  totals.forEach(([label, value], i) => {
    const isTotal = i === totals.length - 1;
    doc.fillColor(isTotal ? dark : muted).fontSize(isTotal ? 12 : 10).font(isTotal ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(label, 300, y, { width: 140 });
    doc.text(value, 445, y, { width: 90, align: 'right' });
    y += isTotal ? 22 : 16;
  });

  // Footer
  const footer = inv.footerNote || 'Thank you for training with us.';
  doc.fillColor(muted).fontSize(9).font('Helvetica').text(footer, left, 760, { width: right - left, align: 'center' });

  doc.end();
  return done;
}

module.exports = { ensureInvoice, renderInvoicePdf, money, dateLabel };
