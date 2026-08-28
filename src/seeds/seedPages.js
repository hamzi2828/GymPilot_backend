// src/seeds/seedPages.js
// Seeds all static pages for The Jymor
const mongoose = require('mongoose');
const Page = require('../models/pageModel');
require('dotenv').config();

// ============================================
// FAQS PAGE
// ============================================
const faqsContent = JSON.stringify([
  {
    id: "faq-1",
    question: "Do you offer Cash on Delivery (COD)?",
    answer: "Yes. We offer COD across Pakistan. You pay when your order arrives at your door — no advance payment required."
  },
  {
    id: "faq-2",
    question: "What payment methods do you accept?",
    answer: "We accept Cash on Delivery (COD), bank transfer, JazzCash, EasyPaisa, and major debit/credit cards via our secure checkout."
  },
  {
    id: "faq-3",
    question: "Can I change or cancel my order after placing it?",
    answer: "You can cancel or modify your order within 12 hours of placing it. After that, your order may already be packed and dispatched. Contact us on WhatsApp at +92 312 2031137 immediately if you need to make a change."
  },
  {
    id: "faq-4",
    question: "How long does delivery take?",
    answer: "Orders are delivered within 3–5 business days across Pakistan. Major cities like Karachi, Lahore, and Islamabad typically receive orders within 2–3 days. See our full Shipping Policy at /shipping-policy for details on fast delivery clothing Pakistan."
  },
  {
    id: "faq-5",
    question: "Do you offer free shipping?",
    answer: "Yes — we offer free shipping on orders above Rs. 3,000. Orders below this amount have a flat shipping fee of Rs. 200. The current free shipping threshold is shown at checkout."
  },
  {
    id: "faq-6",
    question: "Do you ship internationally?",
    answer: "Currently we ship within Pakistan only. International shipping is coming soon."
  },
  {
    id: "faq-7",
    question: "How do I track my order?",
    answer: "Once your order is dispatched, you'll receive a tracking number via SMS and email. Use this to track your parcel directly with the courier."
  },
  {
    id: "faq-8",
    question: "What is your return policy?",
    answer: "We accept returns within 7 days of delivery, provided the item is unworn, unwashed, and in its original condition with tags attached. Read our full Returns Policy at /return-policy for details on clothing exchange Pakistan."
  },
  {
    id: "faq-9",
    question: "How do I exchange an item for a different size?",
    answer: "Contact us on WhatsApp at +92 312 2031137 or email support@inkedwearpk.com within 7 days of receiving your order. We'll guide you through the exchange process. Please note that exchange items must be in original, unworn condition."
  },
  {
    id: "faq-10",
    question: "Who pays for return shipping?",
    answer: "If the item is faulty or we sent the wrong item, we cover return shipping. For size exchanges or change of mind, return shipping is at the customer's cost."
  },
  {
    id: "faq-11",
    question: "How do I find my correct size?",
    answer: "Visit our Size Guide at /size-guide. We have detailed size charts with measurements in CM and inches for both women's and men's clothing. For help on women clothing sizes Pakistan, our Size Guide has you covered."
  },
  {
    id: "faq-12",
    question: "Are the colours accurate in the product photos?",
    answer: "We do our best to show accurate colours. However, slight variations can occur due to screen settings and lighting. If you're unsure, feel free to ask us for more photos on WhatsApp at +92 312 2031137."
  },
  {
    id: "faq-13",
    question: "How can I contact The Jymor?",
    answer: "WhatsApp: +92 312 2031137 (10 AM–8 PM, Mon–Sat). Email: hello@inkedwearpk.com or support@inkedwearpk.com. We reply within 24 hours."
  },
  {
    id: "faq-14",
    question: "Where are you based?",
    answer: "We are based in Pakistan and deliver nationwide — to every city across the country."
  }
]);

// ============================================
// LOGIN PAGE CONTENT
// ============================================
const loginContent = JSON.stringify({
  mainTitle: "Premium Fashion for",
  highlightedTitle: "Every Side of You",
  description: "Bold women's collections. Powerful activewear. One brand built around you — delivered anywhere in Pakistan.",
  stats: [
    { value: "2019", label: "Founded" },
    { value: "100%", label: "Quality Promise" },
    { value: "Nationwide", label: "Delivery" }
  ],
  features: [
    "Free Shipping on Orders Over Rs. 3,000",
    "Easy 7-Day Returns & Exchanges",
    "Cash on Delivery Nationwide"
  ]
});

// ============================================
// PRIVACY POLICY
// ============================================
const privacyContent = `
<p><em>Last updated: April 2026</em></p>

<p>The Jymor ("we", "us", "our") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and protect your personal information when you visit or make a purchase from <a href="https://www.inkedwearpk.com">inkedwearpk.com</a>.</p>

<h2>Information We Collect</h2>
<p>When you place an order, we collect:</p>
<ul>
  <li>Your name</li>
  <li>Email address</li>
  <li>Phone number</li>
  <li>Delivery address</li>
  <li>Payment information (securely processed)</li>
</ul>
<p>When you browse our website, we automatically collect:</p>
<ul>
  <li>IP address</li>
  <li>Browser type</li>
  <li>Pages viewed</li>
  <li>Cookies for analytics and functionality</li>
</ul>

<h2>How We Use Your Information</h2>
<ul>
  <li>To process and fulfil your orders</li>
  <li>To send order confirmations and shipping updates via SMS and email</li>
  <li>To respond to your customer service enquiries</li>
  <li>To send you marketing emails and offers (only if you opt in)</li>
  <li>To improve our website and shopping experience</li>
</ul>

<h2>Sharing Your Information</h2>
<p>We do not sell your personal information to third parties. We share your delivery information only with our courier partners to fulfil your order. We may share data with analytics providers (e.g. Google Analytics) in anonymised form.</p>

<h2>Cookies</h2>
<p>Our website uses cookies to improve your experience and analyse site traffic. You can disable cookies in your browser settings, though some parts of the site may not function correctly if you do.</p>

<h2>Data Security</h2>
<p>Your personal information is protected using industry-standard encryption. We regularly review and update our security measures to ensure your data remains safe.</p>

<h2>Your Rights</h2>
<p>You have the right to access the personal data we hold about you, request corrections, or ask us to delete your data. To make such a request, email us at <a href="mailto:hello@inkedwearpk.com">hello@inkedwearpk.com</a>.</p>

<h2>Contact</h2>
<p>For any privacy-related questions, contact us at:</p>
<ul>
  <li>Email: <a href="mailto:hello@inkedwearpk.com">hello@inkedwearpk.com</a></li>
  <li>Support: <a href="mailto:support@inkedwearpk.com">support@inkedwearpk.com</a></li>
  <li>WhatsApp: <a href="https://api.whatsapp.com/send?phone=923122031137">+92 312 2031137</a></li>
</ul>

<h2>Policy Updates</h2>
<p>We may update this privacy policy from time to time. Any changes will be posted on this page with an updated revision date.</p>
`;

// ============================================
// TERMS AND CONDITIONS
// ============================================
const termsContent = `
<h2>Introduction</h2>
<p>Welcome to The Jymor. By accessing and using our website (<a href="https://www.inkedwearpk.com">inkedwearpk.com</a>), you agree to be bound by these Terms and Conditions. Please read them carefully before making any purchase.</p>

<h2>Use of Website</h2>
<p>By using our website, you confirm that:</p>
<ul>
  <li>You are at least 18 years old or have parental consent</li>
  <li>You will provide accurate and complete information</li>
  <li>You will not use the website for any unlawful purpose</li>
  <li>You will not attempt to interfere with the website's functionality</li>
</ul>

<h2>Products and Pricing</h2>
<ul>
  <li>All prices are listed in Pakistani Rupees (PKR)</li>
  <li>Prices are subject to change without prior notice</li>
  <li>We reserve the right to limit quantities</li>
  <li>Product images are for illustration purposes; actual colours may vary slightly</li>
  <li>We strive to display accurate product descriptions but do not warrant that descriptions are error-free</li>
</ul>

<h2>Orders and Payment</h2>
<ul>
  <li>Order confirmation is subject to product availability</li>
  <li>We accept Cash on Delivery (COD), bank transfers, JazzCash, EasyPaisa, and major debit/credit cards</li>
  <li>For COD orders, please have exact change ready at delivery</li>
  <li>We reserve the right to cancel orders if fraud is suspected</li>
</ul>

<h2>Shipping and Delivery</h2>
<ul>
  <li>We ship to all cities in Pakistan</li>
  <li>Delivery times are estimates and not guaranteed</li>
  <li>Risk of loss passes to you upon delivery</li>
  <li>Please ensure someone is available to receive the order</li>
</ul>

<h2>Returns and Exchanges</h2>
<ul>
  <li>We offer a 7-day return and exchange policy from the date of delivery</li>
  <li>Items must be unworn, unwashed, and have original tags attached</li>
  <li>Sale items and innerwear/swimwear are not eligible for return</li>
  <li>Customer-initiated return shipping costs are borne by the customer</li>
</ul>

<h2>Intellectual Property</h2>
<p>All content on this website, including text, images, logos, and designs, is the property of The Jymor and is protected by copyright laws. You may not reproduce, distribute, or use any content without our written permission.</p>

<h2>Limitation of Liability</h2>
<p>The Jymor shall not be liable for any indirect, incidental, or consequential damages arising from your use of our website or products. Our liability is limited to the amount paid for the product in question.</p>

<h2>Governing Law</h2>
<p>These Terms and Conditions are governed by the laws of Pakistan. Any disputes shall be resolved in the courts of Pakistan.</p>

<h2>Changes to Terms</h2>
<p>We reserve the right to modify these terms at any time. Continued use of the website after changes constitutes acceptance of the new terms.</p>

<h2>Contact</h2>
<p>For questions about these Terms and Conditions, please contact us at <a href="mailto:hello@inkedwearpk.com">hello@inkedwearpk.com</a>.</p>
`;

// ============================================
// ABOUT US
// ============================================
const aboutContent = `
<h2>We Started With One Idea: You Deserve Better.</h2>
<p>From fashion enthusiasts to a full <a href="https://www.inkedwearpk.com/about-us">Pakistani fashion brand</a> — here's how The Jymor was born.</p>

<p><strong>Founded:</strong> 2019 &nbsp;|&nbsp; <strong>Based in:</strong> Pakistan &nbsp;|&nbsp; <strong>Delivery:</strong> Nationwide &nbsp;|&nbsp; <strong>Quality Promise:</strong> 100%</p>

<h2>Where It All Began</h2>
<p>The Jymor was born out of a simple frustration — the gap between what Pakistani fashion lovers wanted and what was available to them. We saw people searching for clothing that felt premium, looked bold, and actually fit the way real people are built. So in 2019, we decided to build exactly that.</p>

<p>What started as a passion project between a small team of designers and fashion enthusiasts quickly became something bigger. We spent months sourcing fabrics, refining cuts, and testing every piece until it met one standard: would we wear this ourselves? If the answer was yes, it made the cut.</p>

<h2>Building Something Worth Wearing</h2>
<p>From day one, our focus has been on two things: quality you can feel and designs you actually want to wear. We don't chase every trend. We build pieces that belong in your wardrobe for seasons — not just a single occasion.</p>

<p>Our women's collection started with a clear belief: traditional Pakistani aesthetics don't have to compromise on modern fit and finish. And our activewear line was built for the everyday athlete — someone who wants to look sharp whether they're at the gym, on a walk, or just running errands.</p>

<h2>A Brand Built Around You</h2>
<p>Every piece we make is made with you in mind. Not a demographic. Not a statistic. You — the person who knows exactly what they want, who's tired of settling, and who deserves <a href="https://www.inkedwearpk.com/about-us">clothing brand Pakistan</a> that actually fits their life.</p>

<p>We're growing, and we're growing because of the people who've trusted us. If you're reading this, you're part of what The Jymor is becoming. Welcome.</p>

<h2>Our Mission</h2>
<p>To make premium, bold fashion accessible to every man and woman across Pakistan — online, delivered fast, without compromise.</p>

<h2>Our Vision</h2>
<p>To become Pakistan's most trusted online fashion destination — the brand people reach for when they want to look their best, feel confident, and wear something that actually means something.</p>

<h2>Shop Our Collection</h2>
<p>Ready to experience the difference? <a href="https://www.inkedwearpk.com/products">Browse our latest collection</a> and find pieces made for every side of you.</p>

<h2>Get in Touch</h2>
<ul>
  <li>Email: <a href="mailto:hello@inkedwearpk.com">hello@inkedwearpk.com</a></li>
  <li>Support: <a href="mailto:support@inkedwearpk.com">support@inkedwearpk.com</a></li>
  <li>WhatsApp: <a href="https://api.whatsapp.com/send?phone=923122031137">+92 312 2031137</a></li>
</ul>
`;

// ============================================
// SHIPPING POLICY
// ============================================
const shippingContent = `
<h2>Shipping Policy</h2>
<p>We want your order to reach you as quickly and safely as possible. Here's everything you need to know about how we ship — and why we're committed to <a href="https://www.inkedwearpk.com/shipping-policy">fast delivery clothing Pakistan</a>.</p>

<h2>Delivery Timeframes</h2>
<table style="width:100%; border-collapse: collapse; margin: 20px 0;">
  <thead>
    <tr style="background-color: #f5f5f5;">
      <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">Location</th>
      <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">Estimated Delivery</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;">Major Cities (Karachi, Lahore, Islamabad, Rawalpindi, Faisalabad)</td>
      <td style="padding: 12px; border: 1px solid #ddd;">2–3 business days</td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;">Other Cities</td>
      <td style="padding: 12px; border: 1px solid #ddd;">3–5 business days</td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;">Remote Areas</td>
      <td style="padding: 12px; border: 1px solid #ddd;">5–7 business days</td>
    </tr>
  </tbody>
</table>
<p>Orders are processed within 24 hours of placement, Monday to Saturday. Orders placed on Sundays or public holidays are processed the next business day.</p>

<h2>Shipping Charges</h2>
<table style="width:100%; border-collapse: collapse; margin: 20px 0;">
  <thead>
    <tr style="background-color: #f5f5f5;">
      <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">Order Value</th>
      <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">Shipping Fee</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;">Orders above Rs. 3,000</td>
      <td style="padding: 12px; border: 1px solid #ddd;"><strong>FREE Shipping</strong></td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;">Orders below Rs. 3,000</td>
      <td style="padding: 12px; border: 1px solid #ddd;">Rs. 200 flat rate</td>
    </tr>
  </tbody>
</table>

<h2>Cash on Delivery (COD)</h2>
<p>COD is available across Pakistan. You pay in cash when the courier delivers your order — no advance payment required. Please ensure someone is available at the delivery address during business hours to receive and pay for the order.</p>

<h2>Order Tracking</h2>
<p>Once your order is dispatched, you will receive an SMS and email with your tracking number and courier details. Use this number to track your parcel directly on the courier's website. If you don't receive your tracking details within 48 hours of placing your order, contact us at <a href="mailto:support@inkedwearpk.com">support@inkedwearpk.com</a>.</p>

<h2>Incorrect or Incomplete Address</h2>
<p>Please double-check your delivery address at checkout. The Jymor is not responsible for orders delayed or lost due to incorrect addresses provided at the time of order. If you need to update your delivery address, contact us within 12 hours of placing your order.</p>

<h2>Lost or Damaged Orders</h2>
<p>If your order arrives damaged or does not arrive within the expected timeframe, contact us immediately on WhatsApp at <a href="https://api.whatsapp.com/send?phone=923122031137">+92 312 2031137</a> or at <a href="mailto:support@inkedwearpk.com">support@inkedwearpk.com</a>. We will investigate with the courier and resolve the issue for you as quickly as possible.</p>

<h2>Need Help?</h2>
<p>Visit our <a href="https://www.inkedwearpk.com/contact-us">Contact Us</a> page or reach out to us directly — we're here to help.</p>
`;

// ============================================
// RETURN POLICY
// ============================================
const returnContent = `
<h2>Returns & Exchanges</h2>
<p>We want you to love what you ordered. If something isn't right, we're here to make it right. Learn more about our <a href="https://www.inkedwearpk.com/return-policy">clothing exchange Pakistan</a> process below.</p>

<h2>Return Window</h2>
<p>You can request a return or exchange within 7 days of receiving your order. Requests made after 7 days will unfortunately not be accepted.</p>

<h2>Conditions for Return</h2>
<ul>
  <li>Item must be unworn and unwashed</li>
  <li>Item must have original tags still attached</li>
  <li>Item must be in its original packaging</li>
  <li>Items purchased on sale or at discounted prices are not eligible for return</li>
  <li>Innerwear and swimwear are not eligible for return due to hygiene reasons</li>
</ul>

<h2>How to Initiate a Return</h2>
<ol>
  <li>Contact us on WhatsApp at <a href="https://api.whatsapp.com/send?phone=923122031137">+92 312 2031137</a> or email <a href="mailto:support@inkedwearpk.com">support@inkedwearpk.com</a> within 7 days of delivery.</li>
  <li>Provide your order number and reason for return. Attach photos if the item is damaged or incorrect.</li>
  <li>We will confirm eligibility and provide return instructions within 24 hours.</li>
  <li>Once we receive and inspect the returned item, we will process your exchange or refund within 5–7 business days.</li>
</ol>

<h2>Exchanges</h2>
<p>We are happy to exchange your item for a different size or colour, subject to availability. If the item you want is out of stock, we will offer a store credit or full refund.</p>

<h2>Refunds</h2>
<p>Approved refunds are processed within 5–7 business days back to your original payment method. COD refunds are processed via bank transfer — please provide your bank details when requesting a refund.</p>

<h2>Faulty or Incorrect Items</h2>
<p>If you received a faulty item or the wrong product, we sincerely apologise. Contact us immediately with photos and your order number at <a href="mailto:support@inkedwearpk.com">support@inkedwearpk.com</a>. We will arrange a free return pickup and send you the correct item at no extra charge.</p>

<h2>Return Shipping Costs</h2>
<ul>
  <li>Customer-initiated returns (size exchange, change of mind): return shipping cost is at the customer's expense.</li>
  <li>Faulty or incorrect items: we cover all return shipping costs.</li>
</ul>

<h2>Still Have Questions?</h2>
<p>Visit our <a href="https://www.inkedwearpk.com/contact-us">Contact Us</a> page or reach us on WhatsApp — we typically respond within a few hours.</p>
`;

// ============================================
// SIZE GUIDE
// ============================================
const sizeGuideContent = `
<h2>Size Guide</h2>
<p>Not sure which size is right for you? Use our size charts below to find your perfect fit. All measurements are in centimetres (CM). If you're between sizes, we recommend sizing up for a more comfortable fit. Our detailed <a href="https://www.inkedwearpk.com/size-guide">women clothing sizes Pakistan</a> and activewear size guide makes online shopping easy.</p>

<h2>How to Measure Yourself</h2>
<ul>
  <li><strong>Chest / Bust:</strong> Measure around the fullest part of your chest, keeping the tape parallel to the floor.</li>
  <li><strong>Waist:</strong> Measure around your natural waist — the narrowest part of your torso.</li>
  <li><strong>Hips:</strong> Measure around the fullest part of your hips, about 20 cm below your waist.</li>
  <li><strong>Inseam:</strong> Measure from your crotch to the bottom of your ankle.</li>
</ul>

<h2>Women's Clothing Size Chart</h2>
<table style="width:100%; border-collapse: collapse; margin: 20px 0;">
  <thead>
    <tr style="background-color: #f5f5f5;">
      <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Size</th>
      <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Bust (cm)</th>
      <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Waist (cm)</th>
      <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Hips (cm)</th>
    </tr>
  </thead>
  <tbody>
    <tr><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">XS</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">80–83</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">62–65</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">87–90</td></tr>
    <tr><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">S</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">84–87</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">66–69</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">91–94</td></tr>
    <tr><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">M</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">88–92</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">70–74</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">95–99</td></tr>
    <tr><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">L</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">93–97</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">75–80</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">100–104</td></tr>
    <tr><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">XL</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">98–103</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">81–87</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">105–110</td></tr>
    <tr><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">XXL</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">104–110</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">88–94</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">111–117</td></tr>
  </tbody>
</table>

<h2>Men's Activewear Size Chart</h2>
<table style="width:100%; border-collapse: collapse; margin: 20px 0;">
  <thead>
    <tr style="background-color: #f5f5f5;">
      <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Size</th>
      <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Chest (cm)</th>
      <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Waist (cm)</th>
      <th style="padding: 12px; text-align: center; border: 1px solid #ddd;">Inseam (cm)</th>
    </tr>
  </thead>
  <tbody>
    <tr><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">S</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">86–91</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">72–77</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">76</td></tr>
    <tr><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">M</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">92–97</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">78–83</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">78</td></tr>
    <tr><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">L</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">98–103</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">84–89</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">80</td></tr>
    <tr><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">XL</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">104–109</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">90–96</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">82</td></tr>
    <tr><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">XXL</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">110–116</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">97–103</td><td style="padding: 10px; text-align: center; border: 1px solid #ddd;">84</td></tr>
  </tbody>
</table>

<h2>Unstitched Fabric Guide</h2>
<p>Our unstitched suits include the following fabric lengths:</p>
<ul>
  <li><strong>Shirt:</strong> 3 metres</li>
  <li><strong>Trouser/Shalwar:</strong> 2.5 metres</li>
  <li><strong>Dupatta:</strong> 2.5 metres</li>
</ul>

<h2>Still Unsure?</h2>
<p>If you're still unsure about sizing, send us a WhatsApp message at <a href="https://api.whatsapp.com/send?phone=923122031137">+92 312 2031137</a> with your measurements and we'll recommend the right size for you personally. We'd rather you get it right the first time.</p>
`;

// ============================================
// CONTACT US
// ============================================
const contactContent = `
<h2>We're Here to Help</h2>
<p>Have a question about your order, a product, or anything else? We're a real team and we're here for you. Reach out — we typically respond within a few hours.</p>

<h2>Contact Details</h2>
<ul>
  <li><strong>WhatsApp:</strong> <a href="https://api.whatsapp.com/send?phone=923122031137">+92 312 2031137</a> — fastest response, 10 AM to 8 PM PKT, Monday to Saturday</li>
  <li><strong>Email (General):</strong> <a href="mailto:hello@inkedwearpk.com">hello@inkedwearpk.com</a> — we reply within 24 hours</li>
  <li><strong>Email (Support):</strong> <a href="mailto:support@inkedwearpk.com">support@inkedwearpk.com</a></li>
  <li><strong>Email (Wholesale):</strong> <a href="mailto:wholesale@inkedwearpk.com">wholesale@inkedwearpk.com</a></li>
  <li><strong>For Returns:</strong> Visit <a href="https://www.inkedwearpk.com/return-policy">inkedwearpk.com/return-policy</a> to read the policy and initiate a return</li>
</ul>

<h2>Business Hours</h2>
<p>Monday to Saturday: 10:00 AM – 8:00 PM (PKT)<br>
Sunday: Closed</p>

<h2>Follow Us</h2>
<p>Stay connected and get the latest updates:</p>
<ul>
  <li>Instagram: @inkedwearpk</li>
  <li>Facebook: The Jymor</li>
  <li>TikTok: @inkedwearpk</li>
</ul>
`;

// ============================================
// ALL PAGES ARRAY
// ============================================
const pages = [
  {
    title: 'Frequently Asked Questions',
    slug: 'faqs',
    content: faqsContent,
    status: 'published',
    metaTitle: 'FAQs — COD, Shipping & Returns | The Jymor',
    metaDescription: 'Answers to common questions about COD clothing Pakistan, shipping, returns, sizing, and more at The Jymor.',
    metaKeywords: 'COD clothing Pakistan, online clothing Pakistan FAQ, The Jymor delivery Pakistan, The Jymor return policy'
  },
  {
    title: 'Privacy Policy',
    slug: 'privacy-policy',
    content: privacyContent,
    status: 'published',
    metaTitle: 'Privacy Policy | The Jymor',
    metaDescription: 'Learn how The Jymor collects, uses, and protects your personal information. Your privacy is important to us.',
    metaKeywords: 'privacy policy, data protection, The Jymor, personal information'
  },
  {
    title: 'Terms and Conditions',
    slug: 'terms-and-conditions',
    content: termsContent,
    status: 'published',
    metaTitle: 'Terms and Conditions | The Jymor',
    metaDescription: 'Read the terms and conditions for shopping at The Jymor. Understand our policies on orders, payments, shipping, and returns.',
    metaKeywords: 'terms and conditions, terms of service, policies, The Jymor'
  },
  {
    title: 'About Us',
    slug: 'about-us',
    content: aboutContent,
    status: 'published',
    metaTitle: 'About Us | The Jymor — Pakistani Fashion Brand',
    metaDescription: 'Learn about The Jymor, a premium Pakistani fashion brand offering bold women\'s collections and activewear delivered nationwide.',
    metaKeywords: 'The Jymor Pakistan, Pakistani fashion brand, clothing brand Pakistan, premium fashion Pakistan'
  },
  {
    title: 'Shipping Policy',
    slug: 'shipping-policy',
    content: shippingContent,
    status: 'published',
    metaTitle: 'Shipping Policy — Fast Delivery Clothing Pakistan | The Jymor',
    metaDescription: 'Fast delivery clothing Pakistan. Free shipping on orders above Rs. 3,000. Cash on Delivery available nationwide — 2–7 business days.',
    metaKeywords: 'The Jymor shipping Pakistan, fast delivery clothing Pakistan, COD Pakistan, free shipping Pakistan'
  },
  {
    title: 'Return & Exchange Policy',
    slug: 'return-policy',
    content: returnContent,
    status: 'published',
    metaTitle: 'Returns & Exchanges — Clothing Exchange Pakistan | The Jymor',
    metaDescription: 'Easy 7-day returns and exchanges at The Jymor. Learn how to return or exchange items hassle-free.',
    metaKeywords: 'The Jymor return policy, clothing exchange Pakistan, online shopping returns Pakistan'
  },
  {
    title: 'Size Guide',
    slug: 'size-guide',
    content: sizeGuideContent,
    status: 'published',
    metaTitle: 'Size Guide — Women Clothing Sizes Pakistan | The Jymor',
    metaDescription: 'Find your perfect size with detailed size charts for women\'s clothing and men\'s activewear. Measurements in CM.',
    metaKeywords: 'women clothing sizes Pakistan, activewear size guide Pakistan, The Jymor size chart'
  },
  {
    title: 'Contact Us',
    slug: 'contact-us',
    content: contactContent,
    status: 'published',
    metaTitle: 'Contact Us | The Jymor',
    metaDescription: 'Contact The Jymor via WhatsApp +92 312 2031137, email hello@inkedwearpk.com or support@inkedwearpk.com. We reply within 24 hours.',
    metaKeywords: 'contact The Jymor, customer support, WhatsApp, email, Pakistan fashion support'
  },
  {
    title: 'Login Page Content',
    slug: 'login-content',
    content: loginContent,
    status: 'published',
    metaTitle: 'Login — The Jymor',
    metaDescription: 'Sign in to your The Jymor account to access exclusive deals, track orders, and manage your profile.',
    metaKeywords: 'login, signin, account, The Jymor'
  }
];

// ============================================
// SEEDER FUNCTION
// ============================================
async function seedPages() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Delete existing pages
    console.log('\n--- Deleting Existing Pages ---');
    const deleteResult = await Page.deleteMany({});
    console.log(`Deleted ${deleteResult.deletedCount} existing pages`);

    // Create all pages
    console.log('\n--- Creating Static Pages ---');
    for (const pageData of pages) {
      await Page.create(pageData);
      console.log(`Created: ${pageData.title}`);
    }

    console.log('\n=== Pages Seeded Successfully! ===');
    console.log('\nPage URLs:');
    pages.forEach(page => {
      console.log(`  - /${page.slug}`);
    });

  } catch (error) {
    console.error('Error seeding pages:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

seedPages();
