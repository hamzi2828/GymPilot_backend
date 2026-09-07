// src/models/contentPageModel.js
//
// The pages a gym has to be able to change without a developer: FAQs, the
// privacy policy, the terms.
//
// All three were hardcoded React components. The FAQ was worse than merely
// static -- it still asked "How Do I Shop?" and answered it with delivery
// times, because it came from the clothing store this project was converted
// from. A gym cannot fix that, or add a question about class cancellations, or
// publish the terms its own solicitor wrote, without someone editing JSX.
//
// One model covers both shapes, because the alternative is two models that
// differ only in which field holds the words:
//
//   type 'faq'      -> `faqs`, a list of question/answer pairs by section
//   type 'richtext' -> `body`, one block of HTML
//
// Slugs are fixed and known to the frontend routes, so a page cannot be
// renamed out from under the URL that links to it.

const mongoose = require('mongoose');
const { tenantModel } = require('../platform/modelRegistry');

// The pages the frontend has routes for. Adding one here is not enough on its
// own -- it needs a route too -- but it stops an admin inventing a slug that
// nothing renders.
const KNOWN_SLUGS = ['faqs', 'privacy-policy', 'terms'];

const faqItemSchema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true },
    // HTML, sanitised on the way in by the controller. An answer routinely
    // needs a list or a link ("email us at ..."), and forcing plain text
    // would mean a policy written as one long paragraph.
    answer: { type: String, required: true },
    order: { type: Number, default: 0 }
  },
  { _id: true }
);

const sectionSchema = new mongoose.Schema(
  {
    heading: { type: String, default: '', trim: true },
    // Intro prose above the questions, optional.
    body: { type: String, default: '' },
    items: { type: [faqItemSchema], default: [] },
    order: { type: Number, default: 0 }
  },
  { _id: true }
);

const contentPageSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      enum: KNOWN_SLUGS
    },
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, default: '', trim: true },

    type: {
      type: String,
      enum: ['faq', 'richtext'],
      default: 'richtext'
    },

    // richtext pages
    body: { type: String, default: '' },

    // faq pages
    sections: { type: [sectionSchema], default: [] },

    seo: {
      metaTitle: { type: String, default: '', trim: true },
      metaDescription: { type: String, default: '', trim: true }
    },

    // An unpublished page still 404s on the public site, so a policy can be
    // drafted before it goes live.
    isPublished: { type: Boolean, default: true },

    // Shown to visitors on policy pages, which is the one place a date
    // genuinely matters -- "last updated" is part of what a privacy policy is.
    effectiveFrom: { type: Date, default: null },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' }
  },
  {
    timestamps: true,
    // Prefixed: this database is shared with another application, and `pages`
    // is a name any CMS might claim. See attendanceModel.js.
    collection: 'gym_content_pages'
  }
);

contentPageSchema.statics.KNOWN_SLUGS = KNOWN_SLUGS;

/** The public read: published only, and never the admin bookkeeping fields. */
contentPageSchema.statics.publicBySlug = function (slug) {
  return this.findOne({ slug: String(slug || '').toLowerCase().trim(), isPublished: true })
    .select('-updatedBy -updatedByName -__v')
    .lean();
};

module.exports =
  tenantModel('ContentPage', contentPageSchema);
