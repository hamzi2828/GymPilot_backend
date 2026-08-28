/**
 * Email Templates for Order and Return Notifications
 */

const STORE_NAME = 'The Jymor';
const SUPPORT_EMAIL = 'support@inkedwearpk.com';

/**
 * Format currency
 */
function formatCurrency(amount) {
  return `$${(amount || 0).toFixed(2)}`;
}

/**
 * Format date
 */
function formatDate(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

/**
 * Get reason display text
 */
function getReasonDisplayText(reason) {
  const reasonMap = {
    'defective': 'Defective Product',
    'wrong_item': 'Wrong Item Received',
    'not_as_described': 'Not as Described',
    'size_issue': 'Size Issue',
    'changed_mind': 'Changed Mind',
    'quality_issue': 'Quality Issue',
    'damaged_in_shipping': 'Damaged in Shipping',
    'other': 'Other'
  };
  return reasonMap[reason] || reason;
}

/**
 * Base email wrapper
 */
function wrapEmail(content) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${STORE_NAME}</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f5f5f5;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 30px 40px; text-align: center; border-bottom: 1px solid #eee;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 600; color: #333;">${STORE_NAME}</h1>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; text-align: center; border-top: 1px solid #eee; background-color: #fafafa; border-radius: 0 0 8px 8px;">
              <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Questions? Contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color: #333;">${SUPPORT_EMAIL}</a></p>
              <p style="margin: 0; font-size: 12px; color: #999;">&copy; ${new Date().getFullYear()} ${STORE_NAME}. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Generate order items HTML
 */
function generateOrderItemsHtml(items) {
  if (!items || items.length === 0) return '';

  return items.map(item => {
    const productName = item.product?.name || 'Product';
    return `
      <tr>
        <td style="padding: 15px 0; border-bottom: 1px solid #eee;">
          <p style="margin: 0 0 5px; font-weight: 600; color: #333;">${productName}</p>
          <p style="margin: 0; font-size: 14px; color: #666;">Size: ${item.size || 'N/A'} | Color: ${item.color || 'N/A'} | Qty: ${item.quantity}</p>
        </td>
        <td style="padding: 15px 0; border-bottom: 1px solid #eee; text-align: right; font-weight: 600; color: #333;">
          ${formatCurrency(item.price * item.quantity)}
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Generate order summary HTML
 */
function generateOrderSummaryHtml(order) {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top: 20px;">
      <tr>
        <td style="padding: 10px 0; color: #666;">Subtotal</td>
        <td style="padding: 10px 0; text-align: right; color: #333;">${formatCurrency(order.subtotal)}</td>
      </tr>
      ${order.shippingCost > 0 ? `
      <tr>
        <td style="padding: 10px 0; color: #666;">Shipping</td>
        <td style="padding: 10px 0; text-align: right; color: #333;">${formatCurrency(order.shippingCost)}</td>
      </tr>
      ` : ''}
      ${order.tax > 0 ? `
      <tr>
        <td style="padding: 10px 0; color: #666;">Tax</td>
        <td style="padding: 10px 0; text-align: right; color: #333;">${formatCurrency(order.tax)}</td>
      </tr>
      ` : ''}
      ${order.discount > 0 ? `
      <tr>
        <td style="padding: 10px 0; color: #666;">Discount</td>
        <td style="padding: 10px 0; text-align: right; color: #28a745;">-${formatCurrency(order.discount)}</td>
      </tr>
      ` : ''}
      <tr>
        <td style="padding: 15px 0; font-weight: 600; font-size: 18px; color: #333; border-top: 2px solid #eee;">Total</td>
        <td style="padding: 15px 0; text-align: right; font-weight: 600; font-size: 18px; color: #333; border-top: 2px solid #eee;">${formatCurrency(order.total)}</td>
      </tr>
    </table>
  `;
}

/**
 * Order Confirmed Email
 */
function orderConfirmed(order) {
  const customerName = order.shippingAddress?.fullName || 'Valued Customer';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">Thank you for your order!</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, we've received your order and are getting it ready. We'll send you another email when your order ships.
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Order Number</p>
      <p style="margin: 0; font-size: 20px; font-weight: 600; color: #333;">${order.orderNumber}</p>
    </div>

    <h3 style="margin: 0 0 15px; font-size: 18px; color: #333;">Order Details</h3>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${generateOrderItemsHtml(order.items)}
    </table>

    ${generateOrderSummaryHtml(order)}

    <div style="margin-top: 30px; padding: 20px; background-color: #f8f9fa; border-radius: 8px;">
      <h4 style="margin: 0 0 10px; font-size: 16px; color: #333;">Shipping Address</h4>
      <p style="margin: 0; font-size: 14px; color: #666; line-height: 1.6;">
        ${customerName}<br>
        ${order.shippingAddress?.address || ''}<br>
        ${order.shippingAddress?.city || ''}, ${order.shippingAddress?.state || ''} ${order.shippingAddress?.zipCode || ''}<br>
        ${order.shippingAddress?.country || ''}
      </p>
    </div>
  `;

  return {
    subject: `Order Confirmed - ${order.orderNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Order Processing Email
 */
function orderProcessing(order) {
  const customerName = order.shippingAddress?.fullName || 'Valued Customer';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">We're preparing your order!</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, great news! We're now preparing your order for shipment. You'll receive another email with tracking information once it's on its way.
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Order Number</p>
      <p style="margin: 0; font-size: 20px; font-weight: 600; color: #333;">${order.orderNumber}</p>
    </div>

    <div style="text-align: center; padding: 30px 0;">
      <div style="display: inline-block; background-color: #fff3cd; color: #856404; padding: 15px 30px; border-radius: 50px; font-weight: 600;">
        📦 Order Being Prepared
      </div>
    </div>

    <p style="margin: 20px 0 0; font-size: 14px; color: #666; text-align: center;">
      We'll notify you as soon as your order ships!
    </p>
  `;

  return {
    subject: `Order Being Prepared - ${order.orderNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Order Shipped Email
 */
function orderShipped(order) {
  const customerName = order.shippingAddress?.fullName || 'Valued Customer';
  const trackingNumber = order.trackingNumber;

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">Your order is on its way!</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, your order has been shipped and is on its way to you!
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Order Number</p>
      <p style="margin: 0 0 20px; font-size: 20px; font-weight: 600; color: #333;">${order.orderNumber}</p>
      ${trackingNumber ? `
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Tracking Number</p>
      <p style="margin: 0; font-size: 18px; font-weight: 600; color: #007bff;">${trackingNumber}</p>
      ` : ''}
    </div>

    <div style="text-align: center; padding: 30px 0;">
      <div style="display: inline-block; background-color: #d4edda; color: #155724; padding: 15px 30px; border-radius: 50px; font-weight: 600;">
        🚚 Order Shipped
      </div>
    </div>

    <div style="margin-top: 30px; padding: 20px; background-color: #f8f9fa; border-radius: 8px;">
      <h4 style="margin: 0 0 10px; font-size: 16px; color: #333;">Shipping To</h4>
      <p style="margin: 0; font-size: 14px; color: #666; line-height: 1.6;">
        ${customerName}<br>
        ${order.shippingAddress?.address || ''}<br>
        ${order.shippingAddress?.city || ''}, ${order.shippingAddress?.state || ''} ${order.shippingAddress?.zipCode || ''}<br>
        ${order.shippingAddress?.country || ''}
      </p>
    </div>
  `;

  return {
    subject: `Your Order Has Shipped - ${order.orderNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Order Delivered Email
 */
function orderDelivered(order) {
  const customerName = order.shippingAddress?.fullName || 'Valued Customer';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">Your order has been delivered!</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, your order has been delivered. We hope you love your purchase!
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Order Number</p>
      <p style="margin: 0; font-size: 20px; font-weight: 600; color: #333;">${order.orderNumber}</p>
    </div>

    <div style="text-align: center; padding: 30px 0;">
      <div style="display: inline-block; background-color: #d4edda; color: #155724; padding: 15px 30px; border-radius: 50px; font-weight: 600;">
        ✅ Delivered
      </div>
    </div>

    <p style="margin: 20px 0; font-size: 14px; color: #666; text-align: center; line-height: 1.6;">
      If you have any issues with your order or need to make a return, please don't hesitate to contact us.
    </p>
  `;

  return {
    subject: `Order Delivered - ${order.orderNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Order Cancelled Email
 */
function orderCancelled(order) {
  const customerName = order.shippingAddress?.fullName || 'Valued Customer';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">Your order has been cancelled</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, your order has been cancelled as requested.
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Order Number</p>
      <p style="margin: 0; font-size: 20px; font-weight: 600; color: #333;">${order.orderNumber}</p>
    </div>

    <div style="text-align: center; padding: 30px 0;">
      <div style="display: inline-block; background-color: #f8d7da; color: #721c24; padding: 15px 30px; border-radius: 50px; font-weight: 600;">
        ❌ Order Cancelled
      </div>
    </div>

    <p style="margin: 20px 0; font-size: 14px; color: #666; text-align: center; line-height: 1.6;">
      If you were charged, a refund will be processed within 5-10 business days.
    </p>
  `;

  return {
    subject: `Order Cancelled - ${order.orderNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Order Refunded Email
 */
function orderRefunded(order) {
  const customerName = order.shippingAddress?.fullName || 'Valued Customer';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">Your refund has been processed</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, we've processed your refund. The funds should appear in your account within 5-10 business days.
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Order Number</p>
      <p style="margin: 0 0 20px; font-size: 20px; font-weight: 600; color: #333;">${order.orderNumber}</p>
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Refund Amount</p>
      <p style="margin: 0; font-size: 24px; font-weight: 600; color: #28a745;">${formatCurrency(order.total)}</p>
    </div>

    <div style="text-align: center; padding: 30px 0;">
      <div style="display: inline-block; background-color: #d4edda; color: #155724; padding: 15px 30px; border-radius: 50px; font-weight: 600;">
        💰 Refund Processed
      </div>
    </div>

    <p style="margin: 20px 0; font-size: 14px; color: #666; text-align: center; line-height: 1.6;">
      Thank you for shopping with us. We hope to see you again!
    </p>
  `;

  return {
    subject: `Refund Processed - ${order.orderNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Return Submitted Email
 */
function returnSubmitted(returnOrder, order) {
  const customerName = order?.shippingAddress?.fullName || 'Valued Customer';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">Return request received</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, we've received your return request and are reviewing it. We'll get back to you within 1-2 business days.
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Return Number</p>
      <p style="margin: 0 0 20px; font-size: 20px; font-weight: 600; color: #333;">${returnOrder.returnNumber}</p>
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Original Order</p>
      <p style="margin: 0 0 20px; font-size: 16px; color: #333;">${order?.orderNumber || 'N/A'}</p>
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Reason</p>
      <p style="margin: 0; font-size: 16px; color: #333;">${getReasonDisplayText(returnOrder.reason)}</p>
    </div>

    <h3 style="margin: 0 0 15px; font-size: 18px; color: #333;">Items for Return</h3>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${generateOrderItemsHtml(returnOrder.items)}
    </table>

    <div style="margin-top: 20px; padding: 15px; background-color: #e7f3ff; border-radius: 8px;">
      <p style="margin: 0; font-size: 14px; color: #0056b3;">
        <strong>Estimated Refund:</strong> ${formatCurrency(returnOrder.refundAmount)}
      </p>
    </div>
  `;

  return {
    subject: `Return Request Received - ${returnOrder.returnNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Return Approved Email
 */
function returnApproved(returnOrder, order) {
  const customerName = order?.shippingAddress?.fullName || 'Valued Customer';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">Your return has been approved!</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, great news! Your return request has been approved. Please follow the instructions below to complete your return.
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Return Number</p>
      <p style="margin: 0; font-size: 20px; font-weight: 600; color: #333;">${returnOrder.returnNumber}</p>
    </div>

    <div style="text-align: center; padding: 30px 0;">
      <div style="display: inline-block; background-color: #d4edda; color: #155724; padding: 15px 30px; border-radius: 50px; font-weight: 600;">
        ✅ Return Approved
      </div>
    </div>

    <div style="margin-top: 30px; padding: 20px; background-color: #fff3cd; border-radius: 8px;">
      <h4 style="margin: 0 0 15px; font-size: 16px; color: #856404;">Return Instructions</h4>
      <ol style="margin: 0; padding-left: 20px; font-size: 14px; color: #856404; line-height: 1.8;">
        <li>Pack the items securely in their original packaging if possible</li>
        <li>Include a copy of this email or your return number (${returnOrder.returnNumber})</li>
        <li>Ship the package to our returns center</li>
        <li>Once we receive and inspect the items, your refund will be processed</li>
      </ol>
    </div>

    <div style="margin-top: 20px; padding: 15px; background-color: #e7f3ff; border-radius: 8px;">
      <p style="margin: 0; font-size: 14px; color: #0056b3;">
        <strong>Refund Amount:</strong> ${formatCurrency(returnOrder.refundAmount)}
      </p>
    </div>
  `;

  return {
    subject: `Return Approved - ${returnOrder.returnNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Return Rejected Email
 */
function returnRejected(returnOrder, order) {
  const customerName = order?.shippingAddress?.fullName || 'Valued Customer';
  const adminNotes = returnOrder.adminNotes || 'No additional details provided.';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">Return request update</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, we've reviewed your return request and unfortunately we're unable to approve it at this time.
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Return Number</p>
      <p style="margin: 0; font-size: 20px; font-weight: 600; color: #333;">${returnOrder.returnNumber}</p>
    </div>

    <div style="text-align: center; padding: 30px 0;">
      <div style="display: inline-block; background-color: #f8d7da; color: #721c24; padding: 15px 30px; border-radius: 50px; font-weight: 600;">
        ❌ Return Not Approved
      </div>
    </div>

    <div style="margin-top: 30px; padding: 20px; background-color: #f8f9fa; border-radius: 8px;">
      <h4 style="margin: 0 0 10px; font-size: 16px; color: #333;">Reason</h4>
      <p style="margin: 0; font-size: 14px; color: #666; line-height: 1.6;">${adminNotes}</p>
    </div>

    <p style="margin: 20px 0; font-size: 14px; color: #666; text-align: center; line-height: 1.6;">
      If you have questions about this decision, please contact our support team.
    </p>
  `;

  return {
    subject: `Return Request Update - ${returnOrder.returnNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Return Received Email
 */
function returnReceived(returnOrder, order) {
  const customerName = order?.shippingAddress?.fullName || 'Valued Customer';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">We've received your return</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, we've received your returned items and are processing your refund. You'll receive another email once it's complete.
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Return Number</p>
      <p style="margin: 0; font-size: 20px; font-weight: 600; color: #333;">${returnOrder.returnNumber}</p>
    </div>

    <div style="text-align: center; padding: 30px 0;">
      <div style="display: inline-block; background-color: #d4edda; color: #155724; padding: 15px 30px; border-radius: 50px; font-weight: 600;">
        📦 Return Received
      </div>
    </div>

    <div style="margin-top: 20px; padding: 15px; background-color: #e7f3ff; border-radius: 8px;">
      <p style="margin: 0; font-size: 14px; color: #0056b3;">
        <strong>Pending Refund:</strong> ${formatCurrency(returnOrder.refundAmount)}
      </p>
    </div>

    <p style="margin: 20px 0; font-size: 14px; color: #666; text-align: center; line-height: 1.6;">
      Your refund will be processed within 2-3 business days.
    </p>
  `;

  return {
    subject: `Return Received - ${returnOrder.returnNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Return Refunded Email
 */
function returnRefunded(returnOrder, order) {
  const customerName = order?.shippingAddress?.fullName || 'Valued Customer';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">Your refund has been processed</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, your return refund has been processed. The funds should appear in your account within 5-10 business days.
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Return Number</p>
      <p style="margin: 0 0 20px; font-size: 20px; font-weight: 600; color: #333;">${returnOrder.returnNumber}</p>
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Refund Amount</p>
      <p style="margin: 0; font-size: 24px; font-weight: 600; color: #28a745;">${formatCurrency(returnOrder.refundAmount)}</p>
    </div>

    <div style="text-align: center; padding: 30px 0;">
      <div style="display: inline-block; background-color: #d4edda; color: #155724; padding: 15px 30px; border-radius: 50px; font-weight: 600;">
        💰 Refund Complete
      </div>
    </div>

    <p style="margin: 20px 0; font-size: 14px; color: #666; text-align: center; line-height: 1.6;">
      Thank you for shopping with us. We hope to see you again!
    </p>
  `;

  return {
    subject: `Refund Processed - ${returnOrder.returnNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Preorder Confirmation Email
 */
function preorderConfirmation(preorder, product) {
  const customerName = preorder.fullName || 'Valued Customer';
  const variantInfo = preorder.variantDetails?.color || preorder.variantDetails?.size
    ? `${preorder.variantDetails.color || ''} ${preorder.variantDetails.size || ''}`.trim()
    : '';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">You're on the list!</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, we've received your pre-order reservation. We'll notify you as soon as <strong>${product.name}</strong> is back in stock!
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Reservation Number</p>
      <p style="margin: 0 0 20px; font-size: 20px; font-weight: 600; color: #333;">${preorder.preorderNumber}</p>
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Product</p>
      <p style="margin: 0 0 10px; font-size: 16px; font-weight: 600; color: #333;">${product.name}</p>
      ${variantInfo ? `<p style="margin: 0 0 10px; font-size: 14px; color: #666;">${variantInfo}</p>` : ''}
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Quantity</p>
      <p style="margin: 0; font-size: 16px; color: #333;">${preorder.quantity}</p>
    </div>

    <div style="text-align: center; padding: 30px 0;">
      <div style="display: inline-block; background-color: #e8d4f8; color: #6b21a8; padding: 15px 30px; border-radius: 50px; font-weight: 600;">
        Pre-Order Reserved
      </div>
    </div>

    <p style="margin: 20px 0 0; font-size: 14px; color: #666; text-align: center; line-height: 1.6;">
      No payment is required now. We'll send you an email when it's time to complete your purchase!
    </p>
  `;

  return {
    subject: `Pre-Order Confirmed - ${preorder.preorderNumber}`,
    html: wrapEmail(content)
  };
}

/**
 * Preorder Back In Stock Email
 */
function preorderBackInStock(preorder, product) {
  const customerName = preorder.fullName || 'Valued Customer';
  const variantInfo = preorder.variantDetails?.color || preorder.variantDetails?.size
    ? `${preorder.variantDetails.color || ''} ${preorder.variantDetails.size || ''}`.trim()
    : '';

  const content = `
    <h2 style="margin: 0 0 20px; font-size: 24px; color: #333;">Great news - it's back in stock!</h2>
    <p style="margin: 0 0 20px; font-size: 16px; color: #666; line-height: 1.6;">
      Hi ${customerName}, the item you reserved is now available! Don't miss your chance to grab it before it sells out again.
    </p>

    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Your Reservation</p>
      <p style="margin: 0 0 20px; font-size: 16px; font-weight: 600; color: #333;">${preorder.preorderNumber}</p>
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Product</p>
      <p style="margin: 0 0 10px; font-size: 18px; font-weight: 600; color: #333;">${product.name}</p>
      ${variantInfo ? `<p style="margin: 0 0 10px; font-size: 14px; color: #666;">${variantInfo}</p>` : ''}
      <p style="margin: 0 0 10px; font-size: 14px; color: #666;">Reserved Quantity</p>
      <p style="margin: 0; font-size: 16px; color: #333;">${preorder.quantity}</p>
    </div>

    <div style="text-align: center; padding: 30px 0;">
      <div style="display: inline-block; background-color: #d4edda; color: #155724; padding: 15px 30px; border-radius: 50px; font-weight: 600;">
        Now Available!
      </div>
    </div>

    <p style="margin: 20px 0; font-size: 14px; color: #666; text-align: center; line-height: 1.6;">
      Visit our store to complete your purchase. Stock is limited!
    </p>
  `;

  return {
    subject: `Back in Stock - ${product.name}`,
    html: wrapEmail(content)
  };
}

module.exports = {
  // Order templates
  orderConfirmed,
  orderProcessing,
  orderShipped,
  orderDelivered,
  orderCancelled,
  orderRefunded,
  // Return templates
  returnSubmitted,
  returnApproved,
  returnRejected,
  returnReceived,
  returnRefunded,
  // Preorder templates
  preorderConfirmation,
  preorderBackInStock
};
