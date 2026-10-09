// src/services/blogs/blogHtml.js
//
// What a blog post is allowed to store.
//
// A post's body is HTML written in the admin editor and put on the public
// site with dangerouslySetInnerHTML -- the same shape as the policy pages
// (controller/contentPageController.js), and sanitised on save for the same
// reason: the website cleans it again when it renders, but a payload left in
// the database is still there for anything else that reads the collection
// (the phone app, an export, a restore into another site).
//
// The tags and attributes are the ones the website's own pass keeps
// (GymPilot_frontend/src/helper/sanitize.ts), so nothing a visitor can see
// today is removed here: an article needs images, code and headings that a
// policy page does not.

const sanitize = require('sanitize-html');

const ARTICLE_TAGS = [
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'mark', 'small', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'div', 'span'
];

// A card on the listing page: light inline emphasis and nothing else.
const EXCERPT_TAGS = ['strong', 'b', 'em', 'i', 'br', 'span'];

/** The post body, with everything but article markup removed. */
function cleanBlogHtml(html) {
  if (html === undefined || html === null) return '';
  return sanitize(String(html), {
    allowedTags: ARTICLE_TAGS,
    allowedAttributes: {
      '*': ['class', 'title'],
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan']
    },
    // Anything not on this list -- javascript:, data:, vbscript: -- is dropped
    // along with the attribute carrying it. Site-relative addresses
    // ('/uploads/...', '#section') have no scheme and are kept.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    // An external link opened from our page should not be able to reach back
    // through window.opener.
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: 'a',
        attribs: attribs.target === '_blank' ? { ...attribs, rel: 'noopener noreferrer' } : attribs
      })
    }
  }).trim();
}

/** The listing-card excerpt: inline emphasis only, at most 500 characters. */
function cleanExcerpt(html) {
  if (typeof html !== 'string') return '';
  return sanitize(html, { allowedTags: EXCERPT_TAGS, allowedAttributes: {} }).trim().slice(0, 500);
}

/**
 * The post's structured data (JSON-LD), as the text to store: it must be a
 * JSON object naming its @context and @type. Stored re-serialised rather
 * than as typed, with `<` written as <, so a page that puts it inside a
 * <script type="application/ld+json"> cannot have that tag closed from
 * inside a string.
 * @param {string|object} value
 * @returns {string}
 * @throws {Error} 'Invalid JSON-LD schema: ...'
 */
function readMetaSchema(value) {
  let schema = value;
  if (typeof value === 'string') {
    try {
      schema = JSON.parse(value);
    } catch (error) {
      throw new Error('Invalid JSON-LD schema: it is not valid JSON');
    }
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('Invalid JSON-LD schema: it must be a JSON object');
  }
  if (!schema['@context'] || !schema['@type']) {
    throw new Error('Invalid JSON-LD schema: it must include @context and @type');
  }
  return writeMetaSchema(schema);
}

/** A schema object as the text to store (see readMetaSchema). */
function writeMetaSchema(schema) {
  return JSON.stringify(schema).replace(/</g, '\\u003c');
}

module.exports = { cleanBlogHtml, cleanExcerpt, readMetaSchema, writeMetaSchema, ARTICLE_TAGS };
