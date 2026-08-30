// src/controller/contentPageController.js
//
// Reading and editing the FAQ, privacy policy and terms.
//
// The one thing worth pointing at here is the sanitising. These pages are
// authored as HTML by an admin and rendered into the public site with
// dangerouslySetInnerHTML, which is the exact shape of a stored-XSS bug: a
// compromised admin account, or a policy pasted from a Word document that
// happens to carry a payload, would otherwise run script on every visitor.
//
// The frontend sanitises again on render (helper/sanitize.ts). Both, not
// either: sanitising only on write leaves whatever is already in the database
// untouched, and sanitising only on render means the raw payload is still
// there for anything else that reads the collection.

const sanitize = require('sanitize-html');
const ContentPage = require('../models/contentPageModel');
const defaults = require('../seeds/contentPageDefaults');

// What a policy or an FAQ answer legitimately needs: structure, emphasis,
// lists, tables and links. No media, no forms, no styling.
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup',
  'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote',
  'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'span'
];

function clean(html) {
  if (!html) return '';
  return sanitize(String(html), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan']
    },
    // Anything not on this list -- javascript:, data:, vbscript: -- is dropped
    // along with the attribute carrying it.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    // An external link opened from our page should not be able to reach back
    // through window.opener.
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: 'a',
        attribs: attribs.target === '_blank'
          ? { ...attribs, rel: 'noopener noreferrer' }
          : attribs
      })
    }
  });
}

function text(value, max = 300) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/** Normalises whatever the editor posted into the schema's shape. */
function readSections(input) {
  if (!Array.isArray(input)) return [];
  return input.map((section, i) => ({
    heading: text(section && section.heading, 200),
    body: clean(section && section.body),
    order: Number.isFinite(Number(section && section.order)) ? Number(section.order) : i,
    items: Array.isArray(section && section.items)
      ? section.items
          .filter((item) => item && String(item.question || '').trim())
          .map((item, j) => ({
            question: text(item.question, 500),
            answer: clean(item.answer),
            order: Number.isFinite(Number(item.order)) ? Number(item.order) : j
          }))
      : []
  }));
}

module.exports = {
  // -------------------------------------------------------------------------
  // GET /content/:slug   (public)
  //
  // 404s on an unpublished page rather than returning it with a flag, so a
  // draft policy cannot be read by guessing the URL.
  // -------------------------------------------------------------------------
  getPublic: async (req, res) => {
    try {
      const page = await ContentPage.publicBySlug(req.params.slug);
      if (!page) {
        return res.status(404).json({ success: false, message: 'Page not found' });
      }
      return res.json({ success: true, data: page });
    } catch (error) {
      console.error('getPublic content page error:', error);
      return res.status(500).json({ success: false, message: 'Could not load this page' });
    }
  },

  // GET /content   (admin) — every page, including drafts
  list: async (req, res) => {
    try {
      // Seeded on first read rather than by a migration: a gym that upgrades
      // into this feature should find three editable pages waiting, not three
      // empty ones it has to create by hand.
      await defaults.ensureSeeded();

      const pages = await ContentPage.find({}).sort({ slug: 1 }).lean();
      return res.json({
        success: true,
        data: pages,
        known_slugs: ContentPage.KNOWN_SLUGS
      });
    } catch (error) {
      console.error('list content pages error:', error);
      return res.status(500).json({ success: false, message: 'Could not load pages' });
    }
  },

  // GET /content/:slug/admin — one page, published or not
  getOne: async (req, res) => {
    try {
      await defaults.ensureSeeded();
      const page = await ContentPage.findOne({ slug: req.params.slug }).lean();
      if (!page) return res.status(404).json({ success: false, message: 'Page not found' });
      return res.json({ success: true, data: page });
    } catch (error) {
      console.error('get content page error:', error);
      return res.status(500).json({ success: false, message: 'Could not load this page' });
    }
  },

  // PUT /content/:slug
  update: async (req, res) => {
    try {
      const slug = String(req.params.slug || '').toLowerCase().trim();
      if (!ContentPage.KNOWN_SLUGS.includes(slug)) {
        return res.status(400).json({
          success: false,
          message: `Unknown page. Valid pages are: ${ContentPage.KNOWN_SLUGS.join(', ')}`
        });
      }

      await defaults.ensureSeeded();
      const page = await ContentPage.findOne({ slug });
      if (!page) return res.status(404).json({ success: false, message: 'Page not found' });

      const { title, subtitle, body, sections, seo, isPublished, effectiveFrom } = req.body;

      if (title !== undefined) page.title = text(title, 200) || page.title;
      if (subtitle !== undefined) page.subtitle = text(subtitle, 500);
      if (body !== undefined) page.body = clean(body);
      if (sections !== undefined) page.sections = readSections(sections);
      if (isPublished !== undefined) page.isPublished = isPublished === true || isPublished === 'true';
      if (effectiveFrom !== undefined) {
        const d = effectiveFrom ? new Date(effectiveFrom) : null;
        page.effectiveFrom = d && !Number.isNaN(d.getTime()) ? d : null;
      }
      if (seo && typeof seo === 'object') {
        page.seo = {
          metaTitle: text(seo.metaTitle, 200),
          metaDescription: text(seo.metaDescription, 400)
        };
      }

      page.updatedBy = req.user && req.user.id;
      page.updatedByName = req.user
        ? [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email
        : '';

      await page.save();

      return res.json({ success: true, message: 'Page saved.', data: page.toObject() });
    } catch (error) {
      console.error('update content page error:', error);
      return res.status(500).json({ success: false, message: 'Could not save this page', error: error.message });
    }
  },

  // POST /content/:slug/reset — put the shipped default back
  reset: async (req, res) => {
    try {
      const slug = String(req.params.slug || '').toLowerCase().trim();
      const restored = await defaults.resetToDefault(slug);
      if (!restored) {
        return res.status(400).json({ success: false, message: 'Unknown page' });
      }
      return res.json({ success: true, message: 'Page reset to the default text.', data: restored });
    } catch (error) {
      console.error('reset content page error:', error);
      return res.status(500).json({ success: false, message: 'Could not reset this page' });
    }
  }
};
