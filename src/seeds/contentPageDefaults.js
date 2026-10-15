// src/seeds/contentPageDefaults.js
//
// The text these pages ship with, so a new install has three usable pages
// rather than three empty ones.
//
// What was there before came from the clothing store this project was
// converted from: the FAQ opened with "How Do I Shop?" and went on about
// delivery times and returns. None of it was true of a gym, and none of it
// could be changed without editing JSX.
//
// These defaults are written for a gym, and deliberately written to be
// EDITED -- opening hours, notice periods and the like are left as obvious
// blanks in square brackets rather than invented, because a plausible-looking
// wrong number in a policy is worse than a visible gap.
//
// Nothing here is legal advice. The privacy and terms pages are a starting
// skeleton with the right headings; a gym should have them reviewed.

const ContentPage = require('../models/contentPageModel');

const FAQ = {
  slug: 'faqs',
  type: 'faq',
  title: 'Frequently asked questions',
  subtitle: 'Membership, classes, and how things work here.',
  seo: {
    metaTitle: 'FAQs',
    metaDescription: 'Answers to common questions about membership, classes, bookings and facilities.'
  },
  sections: [
    {
      heading: 'Membership',
      order: 0,
      items: [
        {
          question: 'How do I join?',
          answer:
            '<p>Pick a package from the <a href="/packages">packages page</a> and complete the sign-up online, or come to the front desk and we will set it up for you. You will get an email confirming your membership and the date it runs until.</p>',
          order: 0
        },
        {
          question: 'Can I try before I join?',
          answer:
            '<p>Yes. Ask at the front desk about a trial session — we will show you around and you can use the floor before committing to anything.</p>',
          order: 1
        },
        {
          question: 'When does my membership run out, and will I be warned?',
          answer:
            '<p>Your end date is shown in <a href="/user-detail">your account</a>. We email you before it lapses so nothing stops without notice, and the front desk will also tell you when you check in.</p>',
          order: 2
        },
        {
          question: 'How do I renew?',
          answer:
            '<p>Buy a package again from the <a href="/packages">packages page</a>, or renew at the front desk. Renewing before your current membership ends keeps your class bookings.</p>',
          order: 3
        },
        {
          question: 'Can I freeze or cancel my membership?',
          answer:
            '<p>Speak to us at the front desk or use the <a href="/contact-us">contact form</a>. [Set out your gym\'s freeze and cancellation terms here, including any notice period.]</p>',
          order: 4
        }
      ]
    },
    {
      heading: 'Classes and booking',
      order: 1,
      items: [
        {
          question: 'How do I book a class?',
          answer:
            '<p>Open <a href="/classes">Classes</a>, choose a class, pick one of its upcoming sessions and press <strong>Book a place</strong>. You need to be signed in. Your booked classes appear under <em>My classes</em> in your account.</p>',
          order: 0
        },
        {
          question: 'The class I want is full — what happens?',
          answer:
            '<p>You can join the waiting list. If somebody cancels, the first person waiting is moved into the place automatically and we email them. You can see your position on the class page and under <em>My classes</em>.</p>',
          order: 1
        },
        {
          question: 'How do I cancel a booking?',
          answer:
            '<p>From the class page or from <em>My classes</em> in your account. Please cancel if you cannot make it — it frees the place for somebody on the waiting list.</p>',
          order: 2
        },
        {
          question: 'How late can I book?',
          answer:
            '<p>Booking closes shortly before a class starts. After that, come to the front desk and we will add you if there is room.</p>',
          order: 3
        },
        {
          question: 'What if I do not turn up?',
          answer:
            '<p>The class is marked as a no-show against your account. [Set out your gym\'s no-show policy here, if you have one.]</p>',
          order: 4
        }
      ]
    },
    {
      heading: 'At the gym',
      order: 2,
      items: [
        {
          question: 'What are your opening hours?',
          answer: '<p>[Add your opening hours here.]</p>',
          order: 0
        },
        {
          question: 'How do I check in?',
          answer:
            '<p>Use the reader at the front desk, or give your name or member code to the person on the desk. Your visits are recorded and you can see them under <em>Recent visits</em> in your account.</p>',
          order: 1
        },
        {
          question: 'What should I bring?',
          answer:
            '<p>Training kit, clean indoor trainers, a towel and a water bottle. [Add anything else your gym requires.]</p>',
          order: 2
        },
        {
          question: 'Do you have lockers, showers or parking?',
          answer: '<p>[Describe your facilities here.]</p>',
          order: 3
        }
      ]
    },
    {
      heading: 'Account and payments',
      order: 3,
      items: [
        {
          question: 'I have forgotten my password.',
          answer:
            '<p>Use <a href="/authentication?mode=forgot">forgot password</a> on the sign-in screen. We will email you a link to set a new one. The link is valid for one hour and can only be used once.</p>',
          order: 0
        },
        {
          question: 'How do I change my details?',
          answer: '<p>Sign in and open <a href="/user-detail">your account</a>, then edit your profile.</p>',
          order: 1
        },
        {
          question: 'What payment methods do you take?',
          answer:
            '<p>Card online, and [cash / bank transfer / card] at the front desk. Your payment history is in your account.</p>',
          order: 2
        }
      ]
    }
  ]
};

const PRIVACY = {
  slug: 'privacy-policy',
  type: 'richtext',
  title: 'Privacy policy',
  subtitle: 'What we collect, why, and what you can ask us to do about it.',
  seo: {
    metaTitle: 'Privacy policy',
    metaDescription: 'How we collect, use and protect your personal data.'
  },
  body: `
<p><strong>This is a starting template and not legal advice.</strong> Have it reviewed before you rely on it, and replace every bracketed section with your own details.</p>

<h2>Who we are</h2>
<p>[Your gym's registered name and address.] If you have any question about this policy or about your data, contact us at [privacy@yourgym.com].</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Account details</strong> — your name, email address, phone number and date of birth.</li>
  <li><strong>Membership and payment records</strong> — which package you bought, when it runs out, and what you paid. Card details are handled by our payment provider and are never stored on our systems.</li>
  <li><strong>Attendance</strong> — the times you check in and out.</li>
  <li><strong>Class bookings</strong> — the sessions you book, attend or miss.</li>
  <li><strong>Fingerprint data</strong> — only if you choose to register a finger for check-in. See below.</li>
</ul>

<h2>Fingerprint check-in</h2>
<p>Registering a fingerprint is optional. You can check in by name or member code instead, and you can ask us to delete a registered fingerprint at any time.</p>
<p>What is stored is a mathematical template, not an image of your finger, and it cannot be turned back into one. It is encrypted at rest and is only ever sent to a front-desk computer so that it can match a scan locally.</p>

<h2>Why we use it</h2>
<ul>
  <li>To provide the membership you bought and let you into the gym.</li>
  <li>To let you book classes and to tell you when a booking changes.</li>
  <li>To tell you when your membership is about to run out.</li>
  <li>To keep the records we are required to keep, including for accounting.</li>
</ul>

<h2>Marketing</h2>
<p>We only send marketing email if you have asked for it, and every one of those emails has an unsubscribe link. Emails about your membership, your bookings and your account are not marketing and are sent regardless.</p>

<h2>Who else sees it</h2>
<p>Our payment provider, our email provider, and our hosting provider, each only so far as they need to in order to do their job. We do not sell your data.</p>

<h2>How long we keep it</h2>
<p>[State your retention periods.] Financial records are kept for as long as the law requires. Attendance and booking history are kept while you are a member and for [period] afterwards.</p>

<h2>Your rights</h2>
<p>You can ask us to show you the data we hold about you, correct it, delete it, or stop using it for a particular purpose. Write to [privacy@yourgym.com] and we will respond within [30 days].</p>

<h2>Changes</h2>
<p>If we change this policy we will update the date shown on this page.</p>
`.trim()
};

const TERMS = {
  slug: 'terms',
  type: 'richtext',
  title: 'Terms and conditions',
  subtitle: 'The rules of membership.',
  seo: {
    metaTitle: 'Terms and conditions',
    metaDescription: 'The terms that apply to membership, bookings and use of the gym.'
  },
  body: `
<p><strong>This is a starting template and not legal advice.</strong> Have it reviewed before you rely on it, and replace every bracketed section with your own terms.</p>

<h2>Membership</h2>
<p>Membership starts on the date shown on your confirmation and runs until the end date shown in your account. It is personal to you and cannot be transferred or shared.</p>

<h2>Payment</h2>
<p>Membership is payable in advance. [Set out your renewal, late payment and refund terms here.]</p>

<h2>Freezing and cancelling</h2>
<p>[Set out your freeze and cancellation terms, including any notice period and how a member gives notice.]</p>

<h2>Class bookings</h2>
<ul>
  <li>Classes are booked from each class's page and places are limited.</li>
  <li>If a class is full you may join the waiting list; places are released in order.</li>
  <li>Please cancel if you cannot attend, so the place can go to somebody else.</li>
  <li>We may cancel or reschedule a class, and will tell you as far in advance as we can.</li>
</ul>

<h2>Using the gym</h2>
<ul>
  <li>Follow the instructions of staff and any notices displayed in the building.</li>
  <li>Use equipment as intended, and return it after use.</li>
  <li>Do not train if you are unwell or if you have been advised not to.</li>
  <li>We may end a membership without refund for behaviour that puts others at risk.</li>
</ul>

<h2>Health</h2>
<p>You confirm that you are fit to exercise. If you have a medical condition that could affect your training, tell us before you start. If you feel unwell while training, stop and speak to a member of staff.</p>

<h2>Your belongings</h2>
<p>[State your position on lockers and personal property.]</p>

<h2>Liability</h2>
<p>[Set out your liability terms. This section in particular should be written or reviewed by a solicitor.]</p>

<h2>Changes to these terms</h2>
<p>We may update these terms. The version on this page is the one that applies, and the date it took effect is shown above.</p>
`.trim()
};

const DEFAULTS = [FAQ, PRIVACY, TERMS];

function defaultFor(slug) {
  return DEFAULTS.find((page) => page.slug === slug) || null;
}

/**
 * Creates any page that does not exist yet, and leaves alone any that does.
 *
 * Called from the admin read paths rather than run as a migration, so the
 * feature works the moment it is deployed without anyone having to remember a
 * command. Cheap: it is one count when everything is already there.
 */
async function ensureSeeded() {
  const existing = await ContentPage.countDocuments({});
  if (existing >= DEFAULTS.length) return { created: 0 };

  let created = 0;
  for (const page of DEFAULTS) {
    const found = await ContentPage.findOne({ slug: page.slug }).select('_id').lean();
    if (found) continue;
    await ContentPage.create({ ...page, isPublished: true, effectiveFrom: new Date() });
    created += 1;
  }

  if (created) console.log(`[content] seeded ${created} default page(s)`);
  return { created };
}

/** Puts the shipped text back, discarding whatever an admin had written. */
async function resetToDefault(slug) {
  const template = defaultFor(slug);
  if (!template) return null;

  const page = await ContentPage.findOneAndUpdate(
    { slug },
    { ...template, isPublished: true, effectiveFrom: new Date() },
    { new: true, upsert: true }
  ).lean();

  return page;
}

module.exports = { DEFAULTS, defaultFor, ensureSeeded, resetToDefault };
