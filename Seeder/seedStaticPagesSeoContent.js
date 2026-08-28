// seedStaticPagesSeoContent.js
// Appends a keyword-rich SEO enrichment block to every CMS Page (about-us,
// contact-us, faqs, privacy-policy, return-policy, shipping-policy,
// size-guide, terms-and-conditions, login-content).
//
// Design notes:
//  - We do NOT replace the team\'s manually-written content. The enrichment is
//    wrapped in HTML marker comments so the seeder can find and replace it on
//    re-run (idempotent) instead of appending twice.
//  - Each slug gets a distinct enrichment body — no two pages share paragraphs.
//  - meta fields are only filled if currently empty (won\'t overwrite curated
//    metaTitle/metaDescription).
//
// Usage:
//   node Seeder/seedStaticPagesSeoContent.js              # all pages, idempotent
//   node Seeder/seedStaticPagesSeoContent.js --force      # also overwrite meta
//   node Seeder/seedStaticPagesSeoContent.js --slug=faqs  # one page
//   node Seeder/seedStaticPagesSeoContent.js --dry        # preview only

const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const Page = require('../src/models/pageModel');

const MONGO_URI = process.env.MONGO_URI;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry');
const SLUG_FLAG = (args.find((a) => a.startsWith('--slug=')) || '').split('=')[1];

const MARKER_START = '<!-- INKED-WEAR-SEO-ENRICHMENT:START -->';
const MARKER_END = '<!-- INKED-WEAR-SEO-ENRICHMENT:END -->';

// Per-slug enrichment HTML. Each block is unique copy with internal links.
// Lots of natural keyword placement without being spammy.
const ENRICHMENT = {
  'about-us': `
<h2>Why Inked Wear PK Exists</h2>
<p>Inked Wear PK was built on one observation: premium clothing in Pakistan often comes with a markup that has nothing to do with the actual quality of the fabric or stitching. Imported brands charge for the badge. Local boutiques charge for the rent. Customers end up paying a premium tax that doesn\'t translate into better clothes.</p>
<p>We started with the opposite goal — design and source clothing to international quality standards, then price it for the Pakistani market. Every roll of fabric is hand-checked. Every stitch is graded against Pakistani body types, not foreign mannequin sizes. Every order ships with the same care whether you\'re in Karachi, Quetta, or a small town we\'ve never heard of.</p>

<h2>What We Make</h2>
<p>Our catalogue spans three sides of the modern Pakistani wardrobe. <a href="/category/womens-collection">Women\'s clothing</a> covers lawn, pret, co-ords, abayas, and occasion wear — designed for daily life, not just lookbooks. <a href="/category/mens-collection">Men\'s clothing</a> ranges from athletic and tracksuit sets to cargo trousers, polo shirts, kurtas, and shalwar kameez. And our <a href="/category/new-arrivals">new arrivals</a> drop continuously through the year, not just at season change.</p>

<h2>How We Work</h2>
<p>We do not chase trends for the sake of it. Pieces are added when we\'re confident the fabric will hold up wash after wash, the cut suits Pakistani body types, and the price is honest. If something doesn\'t pass our internal review, it doesn\'t go online.</p>
<p>Customer service runs through real people on WhatsApp. We answer fit questions, share unedited fabric photos, and help with size selection before you order. After delivery, our <a href="/return-policy">return and exchange window</a> stays open for 7 days — no friction, no questions buried in fine print.</p>

<h2>Where We Ship</h2>
<p>We deliver across all of Pakistan with Cash on Delivery, including Karachi, Lahore, Islamabad, Rawalpindi, Faisalabad, Multan, Peshawar, Quetta, Hyderabad, Sialkot, Gujranwala, and every smaller town in between. Standard transit time is 2–5 business days; <a href="/shipping-policy">our shipping policy</a> has the full breakdown by region. International shipping is available on request.</p>

<h2>Talk To Us</h2>
<p>If you have a question about fit, fabric, an order, a wholesale enquiry, or just want to share feedback — we read everything. Reach us through <a href="/contact-us">the contact page</a>, WhatsApp at +92 312 2031137, or email at <a href="mailto:contact@inkedwearpk.com">contact@inkedwearpk.com</a>. We\'re a small team and we reply ourselves.</p>
`,

  'contact-us': `
<h2>How To Reach Inked Wear PK</h2>
<p>The fastest way to reach us is WhatsApp at <a href="https://api.whatsapp.com/send?phone=923122031137" target="_blank" rel="noopener">+92 312 2031137</a>. Messages are read by a real person on the team and most enquiries get a reply within an hour during working hours (9am–9pm PKT, every day except Sunday).</p>
<p>For longer enquiries, order issues, or anything you\'d like a written record of, email us at <a href="mailto:contact@inkedwearpk.com">contact@inkedwearpk.com</a>. We aim to respond to every email within 24 hours.</p>

<h2>What We Can Help With</h2>
<p>We answer questions about <a href="/size-guide">sizing and fit</a> before you order — share your measurements and we\'ll recommend the right size for the specific piece you\'re looking at. We can also send unedited fabric photos and short videos showing how a piece moves and drapes in real light, not just studio shots.</p>
<p>For existing orders, message us with your order number and we\'ll pull up the details, share a tracking update, or help with an exchange. Our <a href="/return-policy">return and exchange policy</a> covers seven days from delivery, no questions asked, on unused items with tags attached.</p>
<p>If you\'re a stylist, retailer, or content creator interested in collaborations, wholesale, or press, please email us with details and we\'ll route you to the right person on the team.</p>

<h2>Where We Are</h2>
<p>Inked Wear PK is based in Pakistan. We do not currently operate a physical retail store — every order is shipped directly from our warehouse, which keeps overhead (and your final price) lower. <a href="/shipping-policy">Shipping</a> is available across Pakistan with Cash on Delivery, and to most international destinations on request.</p>

<h2>Quick Links</h2>
<ul>
  <li><a href="/faqs">Frequently asked questions</a> — covers most ordering, payment, and delivery questions before you need to message.</li>
  <li><a href="/shipping-policy">Shipping policy</a> — delivery times, courier partners, and order tracking.</li>
  <li><a href="/return-policy">Return policy</a> — how to swap a size or send something back.</li>
  <li><a href="/size-guide">Size guide</a> — measurements in centimetres and inches across every category.</li>
  <li><a href="/products">Browse all products</a> · <a href="/sales">Current sale</a> · <a href="/blogs">Style journal</a></li>
</ul>
`,

  'faqs': `
<h2>Ordering &amp; Payment</h2>
<p><strong>How do I place an order?</strong> Browse the catalogue, add pieces to your cart, and check out. You can pay online (card, JazzCash, EasyPaisa, bank transfer) or pick Cash on Delivery — you only pay when the courier hands you the parcel.</p>
<p><strong>Is Cash on Delivery available everywhere in Pakistan?</strong> Yes. COD is live across all of Pakistan, including Karachi, Lahore, Islamabad, Rawalpindi, Faisalabad, Multan, Peshawar, Quetta, Hyderabad, Sialkot, Gujranwala, and every smaller city or town we ship to.</p>
<p><strong>Are prices in PKR?</strong> All listed prices are in Pakistani Rupees and include applicable taxes. International orders are billed in PKR and converted by your card or bank.</p>

<h2>Sizing &amp; Fit</h2>
<p><strong>How do I find my size?</strong> Our <a href="/size-guide">size guide</a> has full measurements in centimetres and inches for every category. If you\'re between sizes or have specific concerns, WhatsApp us at +92 312 2031137 with your measurements and we\'ll recommend the right size for that exact piece.</p>
<p><strong>Are your sizes true to standard?</strong> Yes — fits are graded against Pakistani body types, not foreign averages. A Medium from Inked Wear PK reads as a Medium for someone of typical Pakistani build. We deliberately avoid vanity sizing.</p>
<p><strong>Can I exchange for a different size?</strong> Yes — exchanges are free within 7 days of delivery on unused, tag-on items. See our <a href="/return-policy">return policy</a> for the full process.</p>

<h2>Shipping &amp; Delivery</h2>
<p><strong>How long does delivery take?</strong> Standard delivery is 2–5 business days. Karachi, Lahore, and Islamabad are usually faster (often 2 days); smaller cities and remote areas may add 1–2 days. Full breakdown on the <a href="/shipping-policy">shipping policy</a> page.</p>
<p><strong>Will I get a tracking number?</strong> Yes — once your order is dispatched, you\'ll receive an SMS or email with the courier and tracking ID. You can also message us on WhatsApp for live updates.</p>
<p><strong>Do you ship internationally?</strong> Yes, on request. Email us at contact@inkedwearpk.com with your country and shipping address and we\'ll send a quote.</p>

<h2>Returns &amp; Exchanges</h2>
<p><strong>Can I return something I don\'t like?</strong> Yes. We accept returns within 7 days of delivery on unused items with tags attached. Customised, made-to-measure, or sale items are sometimes excluded — the product page will note this.</p>
<p><strong>Who pays for return shipping?</strong> If the return is due to our error (wrong item, defect), we cover return shipping. For change-of-mind returns, return shipping is on the customer.</p>

<h2>Product Care</h2>
<p><strong>How should I wash my Inked Wear PK pieces?</strong> Care instructions are printed on the inside tag of every piece. As a rule of thumb: cold water, gentle cycle, dry flat in shade — most fabrics will reward you for it. Some pieces (silk crepe, embroidered work) are dry-clean recommended.</p>

<h2>Custom &amp; Wholesale</h2>
<p><strong>Do you do custom tailoring?</strong> Yes — see our <a href="/category/custom-tailoring">custom tailoring</a> category, or message us with what you have in mind.</p>
<p><strong>Do you sell wholesale?</strong> For boutique, retailer, or stylist enquiries, email contact@inkedwearpk.com with your business details and order volume.</p>
`,

  'privacy-policy': `
<h2>Plain-English Summary</h2>
<p>The legal text above is the binding version, but here\'s the short version of what we actually do:</p>
<ul>
  <li>We collect your name, address, contact details, and order history so we can ship your orders, follow up if needed, and improve the experience for you next time.</li>
  <li>We do not sell, rent, or share your data with anyone for marketing purposes. Period.</li>
  <li>We share your address only with the courier partner that needs it to deliver your parcel.</li>
  <li>Payment is handled by trusted gateways — your full card number never touches our servers.</li>
  <li>You can email us at <a href="mailto:contact@inkedwearpk.com">contact@inkedwearpk.com</a> any time to access, update, or delete the information we hold about you.</li>
</ul>

<h2>What We Use Cookies For</h2>
<p>We use a small number of cookies to keep your cart between visits, remember whether you\'re logged in, and understand which products and pages get the most attention so we can improve them. We do not use third-party advertising trackers that follow you around the web.</p>

<h2>Your Rights</h2>
<p>You have the right to know what data we hold about you, to correct anything that\'s wrong, and to ask us to delete it. To exercise any of these, email us at <a href="mailto:contact@inkedwearpk.com">contact@inkedwearpk.com</a> and we\'ll respond within seven business days.</p>

<h2>Questions</h2>
<p>If anything in this policy is unclear, the easiest path is to ask. Message us on WhatsApp at +92 312 2031137 or email contact@inkedwearpk.com and we\'ll explain in plain language.</p>
`,

  'return-policy': `
<h2>Return Policy In Plain Language</h2>
<p>You have seven days from the day your parcel is delivered to start a return or exchange. The item must be unused, with all tags attached, in its original packaging. That\'s the whole rule.</p>

<h2>How To Start A Return</h2>
<ol>
  <li>Message us on WhatsApp at +92 312 2031137 or email contact@inkedwearpk.com within 7 days of delivery. Include your order number and the reason (size swap, defect, change of mind — all fine).</li>
  <li>We\'ll send you a return address and a quick checklist. Pack the item with tags attached.</li>
  <li>Drop the parcel with any reliable courier. Share the tracking number with us when you\'ve dispatched it.</li>
  <li>Once we receive and inspect the item, we process the exchange or refund within 3–5 business days.</li>
</ol>

<h2>Exchanges</h2>
<p>Size or colour swaps are the most common request. If the new size is in stock, we ship it the same day we receive your return. If it\'s out of stock, we\'ll either hold the request until restock or issue a full refund — your choice.</p>

<h2>Refunds</h2>
<p>Refunds are issued through the same payment method you used at checkout. Card and online payments are refunded to the original card. Cash on Delivery orders are refunded via bank transfer or JazzCash/EasyPaisa — we\'ll confirm the destination with you.</p>

<h2>Exclusions</h2>
<p>A handful of items can\'t be returned for hygiene or customisation reasons:</p>
<ul>
  <li>Customised, made-to-measure, or stitched-on-order pieces (we cut to your measurements — there\'s no resale).</li>
  <li>Innerwear and certain hosiery items.</li>
  <li>Final-sale or clearance items, when explicitly marked on the product page.</li>
</ul>
<p>If you\'re unsure whether something is returnable, message us before ordering — we\'ll confirm clearly.</p>

<h2>Defective Or Wrong Items</h2>
<p>If your parcel arrives with the wrong item, a manufacturing defect, or transit damage, we cover return shipping and either replace the item or issue a full refund — whichever you prefer. Send us a quick photo or video and we\'ll move fast.</p>

<h2>Quick Links</h2>
<ul>
  <li><a href="/shipping-policy">Shipping policy</a> — delivery timelines and courier partners.</li>
  <li><a href="/size-guide">Size guide</a> — full measurements to help you avoid a return in the first place.</li>
  <li><a href="/contact-us">Contact us</a> — every way to reach the team.</li>
</ul>
`,

  'shipping-policy': `
<h2>Where We Ship</h2>
<p>We deliver to every city and town across Pakistan, including Karachi, Lahore, Islamabad, Rawalpindi, Faisalabad, Multan, Peshawar, Quetta, Hyderabad, Sialkot, Gujranwala, Bahawalpur, Sukkur, Mardan, Mingora, Gilgit, Skardu, and every smaller location served by major couriers. International shipping is available on request — email contact@inkedwearpk.com for a quote.</p>

<h2>Delivery Times</h2>
<p>Standard transit is 2–5 business days from dispatch. Approximate ranges by region:</p>
<ul>
  <li><strong>Karachi, Lahore, Islamabad / Rawalpindi:</strong> 2–3 business days</li>
  <li><strong>Faisalabad, Multan, Sialkot, Gujranwala, Hyderabad, Peshawar:</strong> 2–4 business days</li>
  <li><strong>Other cities and large towns:</strong> 3–5 business days</li>
  <li><strong>Remote areas, Northern Pakistan, AJK:</strong> 4–7 business days (courier-dependent)</li>
</ul>
<p>Orders placed before 5pm PKT on a working day usually dispatch the same day. Orders after 5pm dispatch the next working day.</p>

<h2>Shipping Costs</h2>
<p>Shipping is calculated at checkout based on the item, weight, and destination. Many categories include free shipping above an order threshold — the cart total will show the discount applied automatically. Cash on Delivery may carry a small handling charge depending on the courier; this is shown clearly at checkout, never as a hidden fee on delivery.</p>

<h2>Payment On Delivery</h2>
<p>Cash on Delivery is available on every order across Pakistan. You only pay the courier when they hand you the parcel — no advance payment required. We accept cash, and most of our courier partners now accept JazzCash and EasyPaisa at delivery as well.</p>

<h2>Tracking Your Order</h2>
<p>Once your order is dispatched, you\'ll receive an SMS and email with the courier name and tracking ID. You can either follow it on the courier website or message us at +92 312 2031137 for a live update.</p>

<h2>Couriers We Use</h2>
<p>We work with TCS, Leopards, M&P, BlueEX, and PostEx. The courier assigned to your order is chosen based on your destination and the fastest route — we don\'t lock you into a single carrier.</p>

<h2>Order Issues</h2>
<p>If your parcel is delayed, lost, or damaged in transit, message us right away. We\'ll either chase the courier on your behalf, ship a replacement, or issue a refund — see our <a href="/return-policy">return policy</a> for the full process.</p>

<h2>Eid, Sale &amp; Holiday Periods</h2>
<p>During Eid drops, major sales, or public holiday clusters, dispatch may be 1–2 days slower than usual due to courier load. We post live updates on social and at the top of the homepage during these periods so there are no surprises.</p>
`,

  'size-guide': `
<h2>Why A Good Size Guide Matters</h2>
<p>The single biggest reason for a return is a sizing mismatch — and almost always, it\'s avoidable. We grade our patterns against Pakistani body types, take measurements in both centimetres and inches, and document every category in detail so you can order with confidence the first time.</p>

<h2>How To Measure Yourself</h2>
<ul>
  <li><strong>Bust / Chest:</strong> Wrap the measuring tape around the fullest part, keeping it horizontal. Don\'t pull tight — just snug enough to lie flat.</li>
  <li><strong>Waist:</strong> Around the natural waist (the narrowest point, usually just above the belly button).</li>
  <li><strong>Hip:</strong> Around the fullest part of the hips, feet together.</li>
  <li><strong>Inseam:</strong> From the inside top of your leg straight down to the ankle bone — easiest with a pair of trousers that fits you well, measuring along the seam.</li>
  <li><strong>Shoulder:</strong> From the edge of one shoulder bone across to the other, measured on a t-shirt that fits you, laid flat.</li>
</ul>
<p>Always use a soft measuring tape, not a ruler. Stand naturally — don\'t suck in or push out. If you\'re between two numbers, write down both.</p>

<h2>Choosing Between Sizes</h2>
<p>If your measurements fall between two sizes, the answer depends on the piece:</p>
<ul>
  <li><strong>Tailored or structured</strong> (formal shirts, blazers, trousers): size up for comfort.</li>
  <li><strong>Stretchy or relaxed</strong> (jersey tees, co-ords, loungewear): size down for a cleaner fit.</li>
  <li><strong>Lawn / cotton suits</strong>: size up — these fabrics shrink slightly on the first wash.</li>
  <li><strong>Activewear and tracksuits</strong>: size as listed; we already factor in movement room.</li>
</ul>
<p>When in doubt, message us on WhatsApp at +92 312 2031137 with your measurements and the product link. We\'ll recommend the right size for that specific piece.</p>

<h2>Fabric Behaviour</h2>
<p>Fabric matters as much as cut. Lawn and cotton may shrink 2–4% on the first wash; we account for this in our pattern but note it on the care tag. Silk crepe, satin, and chiffon do not shrink but drape differently across body types — share a photo and we\'ll help you visualise. Linen relaxes after 2–3 wears and softens.</p>

<h2>Common Pakistani Body Types</h2>
<p>Most fit confusion comes from foreign size charts that don\'t match Pakistani proportions. Our charts are calibrated for the most common body types we see — broad shoulders with a slimmer waist for men, defined waist with proportional hips for women — but every piece has its own measurements listed, so you can match against your own without relying on a generic Small / Medium / Large.</p>

<h2>Still Unsure?</h2>
<p>Send us a quick WhatsApp message at +92 312 2031137 with your measurements and the product you\'re looking at. We\'ll reply with a size recommendation within an hour during working hours. If the size doesn\'t work after delivery, our <a href="/return-policy">7-day return and exchange policy</a> has you covered — no questions asked.</p>
`,

  'terms-and-conditions': `
<h2>Plain-English Summary</h2>
<p>The full legal text above is binding, but here\'s the short version:</p>
<ul>
  <li>By using our website or placing an order, you\'re agreeing to the policies on this page and the linked <a href="/privacy-policy">privacy</a>, <a href="/shipping-policy">shipping</a>, and <a href="/return-policy">return</a> pages.</li>
  <li>Product photos are colour-accurate to the best of our ability, but slight variation can happen between screens and real fabric.</li>
  <li>Stock is live but not always perfectly synced — if a piece sells out the moment you order, we\'ll contact you with options (refund, swap, or wait for restock).</li>
  <li>Pricing is in PKR and includes applicable taxes. We may run sales and adjust pricing without notice; orders already placed are honoured at the price you paid.</li>
  <li>Inked Wear PK retains all rights to brand assets, photography, and copy on this site.</li>
</ul>

<h2>Account &amp; Order Use</h2>
<p>If you create an account, please keep your login details private. Don\'t share them or place fraudulent orders — we reserve the right to cancel orders we believe are fraudulent, and to block accounts that abuse the platform.</p>

<h2>Promotions, Discounts &amp; Vouchers</h2>
<p>Promo codes and discount offers are bound by their own terms (date range, minimum order value, eligible categories). The terms are visible at checkout and on the campaign page. Codes can\'t be combined unless explicitly stated. Misuse — including reselling, automating, or stacking codes against the rules — voids the discount and may cancel the order.</p>

<h2>Limitation Of Liability</h2>
<p>We do everything we can to ship the right product, on time, intact. If anything does go wrong (delay, defect, damage), our liability is limited to the value of the order — repair, replace, or refund. We\'re not liable for indirect or consequential damages outside our control (e.g., third-party courier issues beyond reasonable timelines, force-majeure events).</p>

<h2>Changes To These Terms</h2>
<p>We may update these terms from time to time. Significant changes will be flagged on the homepage banner. Continued use of the site after a material change means you accept the new terms — if you don\'t, please stop using the site and message us with concerns.</p>

<h2>Contact</h2>
<p>Questions about anything in these terms? Email <a href="mailto:contact@inkedwearpk.com">contact@inkedwearpk.com</a> or WhatsApp +92 312 2031137 — we\'ll explain in plain language.</p>
`,

  'login-content': `
<h2>Why Create An Inked Wear PK Account</h2>
<p>An account isn\'t required to place an order — Cash on Delivery and guest checkout work fine without one — but signing up unlocks a few practical benefits.</p>
<ul>
  <li><strong>Faster checkout:</strong> your address, phone, and email pre-fill on every order.</li>
  <li><strong>Order history:</strong> review what you bought, when it shipped, and reorder favourites in one click.</li>
  <li><strong>Tracking in one place:</strong> live status of every order without digging through emails.</li>
  <li><strong>Wishlist:</strong> save pieces you\'re considering and come back to them later.</li>
  <li><strong>Early-access drops:</strong> account holders see new arrivals and sale launches before the public homepage updates.</li>
</ul>

<h2>How Sign-Up Works</h2>
<p>You\'ll need an email address and a phone number — both are used only for order updates and account recovery. We don\'t spam, we don\'t sell your data, and you can opt out of marketing emails any time. Read our <a href="/privacy-policy">privacy policy</a> for the full breakdown.</p>

<h2>Forgot Your Password?</h2>
<p>Use the "forgot password" link to reset via email. If you signed up with an email you no longer use, message us at +92 312 2031137 with proof of identity and we\'ll help you recover the account.</p>

<h2>Need Help?</h2>
<p>If anything about logging in isn\'t working — verification email not arriving, password reset failing, account locked — message us on WhatsApp and we\'ll fix it within minutes during working hours. <a href="/contact-us">Contact us</a> · <a href="/faqs">FAQs</a> · <a href="/products">Browse products</a>.</p>
`,
};

// Lightweight default meta if currently empty.
const META_DEFAULTS = {
  'about-us': { metaTitle: 'About Inked Wear PK | Premium Pakistani Fashion', metaDescription: 'Premium clothing made in Pakistan — fair pricing, honest fabric, considered fits. Read the Inked Wear PK story.', metaKeywords: 'about inked wear pk, pakistani fashion brand, premium clothing pakistan' },
  'contact-us': { metaTitle: 'Contact Inked Wear PK | WhatsApp & Email', metaDescription: 'Reach Inked Wear PK on WhatsApp +92 312 2031137 or email. Sizing, orders, returns, wholesale — we reply fast.', metaKeywords: 'contact inked wear pk, whatsapp clothing pakistan, customer support' },
  'faqs': { metaTitle: 'FAQs — Orders, Sizing, Shipping | Inked Wear PK', metaDescription: 'Common questions about ordering, sizing, payment, COD, shipping, and returns at Inked Wear PK. Quick answers, plain language.', metaKeywords: 'inked wear pk faqs, cod pakistan, returns, sizing' },
  'privacy-policy': { metaTitle: 'Privacy Policy | Inked Wear PK', metaDescription: 'How Inked Wear PK collects, uses, and protects your data. Plain-English summary plus full policy.', metaKeywords: 'privacy policy, data protection, inked wear pk' },
  'return-policy': { metaTitle: '7-Day Returns & Exchanges | Inked Wear PK', metaDescription: '7-day return and exchange policy on every Inked Wear PK order. Plain-language steps to return or swap a size.', metaKeywords: 'return policy, exchange, refund, inked wear pk' },
  'shipping-policy': { metaTitle: 'Shipping Across Pakistan | COD | Inked Wear PK', metaDescription: 'Shipping policy: 2–5 day delivery across Pakistan, Cash on Delivery, free shipping thresholds, courier partners.', metaKeywords: 'shipping pakistan, cod, courier, delivery time' },
  'size-guide': { metaTitle: 'Size Guide — Pakistani Fit | Inked Wear PK', metaDescription: 'How to measure yourself and pick the right size at Inked Wear PK. Cm and inches, fabric notes, fit recommendations.', metaKeywords: 'size guide pakistan, measurements, fit guide, inked wear pk' },
  'terms-and-conditions': { metaTitle: 'Terms & Conditions | Inked Wear PK', metaDescription: 'Terms and conditions of using Inked Wear PK. Plain-English summary plus full legal text.', metaKeywords: 'terms and conditions, inked wear pk' },
  'login-content': { metaTitle: 'Login or Sign Up | Inked Wear PK', metaDescription: 'Create an Inked Wear PK account for faster checkout, order tracking, wishlist, and early access to drops.', metaKeywords: 'login, sign up, inked wear pk account' },
};

function buildEnrichmentBlock(slug) {
  const html = ENRICHMENT[slug];
  if (!html) return null;
  // Wrap in a styled container + markers so we can find/replace on re-runs.
  return `${MARKER_START}\n<section class="cms-seo-enrichment">${html}</section>\n${MARKER_END}`;
}

function applyEnrichment(content, block) {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing block.
    return content.slice(0, startIdx) + block + content.slice(endIdx + MARKER_END.length);
  }
  // Append fresh block at end.
  const sep = content.endsWith('\n') ? '' : '\n\n';
  return `${content}${sep}${block}\n`;
}

async function run() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(`Connected: ${mongoose.connection.name}`);

  const filter = SLUG_FLAG ? { slug: SLUG_FLAG } : {};
  const pages = await Page.find(filter);
  if (!pages.length) {
    console.error('No pages found for filter', filter);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Targeting ${pages.length} page(s).`);
  if (DRY) console.log('DRY RUN — no writes will happen.');

  let updated = 0;
  let skipped = 0;
  let totalAdded = 0;

  for (const page of pages) {
    const block = buildEnrichmentBlock(page.slug);
    if (!block) {
      console.log(`  [skip] ${page.slug} — no enrichment template defined`);
      skipped++;
      continue;
    }

    const before = page.content || '';
    const after = applyEnrichment(before, block);
    const lengthDelta = after.length - before.length;

    // Meta tag fill — only set when currently empty (or --force).
    const metaPatch = {};
    const defaults = META_DEFAULTS[page.slug] || {};
    for (const key of ['metaTitle', 'metaDescription', 'metaKeywords']) {
      const current = (page[key] || '').trim();
      if (defaults[key] && (FORCE || !current)) {
        metaPatch[key] = defaults[key];
      }
    }

    if (DRY) {
      console.log(`  [dry]  ${page.slug.padEnd(22)} content ${before.length} → ${after.length} (+${lengthDelta} chars)${Object.keys(metaPatch).length ? ', meta:' + Object.keys(metaPatch).join(',') : ''}`);
      updated++;
      totalAdded += lengthDelta;
      continue;
    }

    page.content = after;
    Object.assign(page, metaPatch);
    if (page.status !== 'published') page.status = 'published';
    await page.save();
    updated++;
    totalAdded += lengthDelta;
    console.log(`  [ok]   ${page.slug.padEnd(22)} +${lengthDelta} chars${Object.keys(metaPatch).length ? ', filled meta:' + Object.keys(metaPatch).join(',') : ''}`);
  }

  console.log('');
  console.log(`Done. Updated: ${updated}. Skipped: ${skipped}. Total chars added: ${totalAdded}.`);
  await mongoose.disconnect();
  console.log('Disconnected.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Seeder failed:', err);
  process.exit(1);
});
