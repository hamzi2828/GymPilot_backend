// src/seeds/updateWhatsAppLinks.js
// Replaces the old `wa.me/` WhatsApp links with `api.whatsapp.com/send?phone=`
// in every stored document that could contain HTML/body copy. The old wa.me
// URLs trigger an HTTP redirect to api.whatsapp.com — flagged in the
// 2026-04-22 Seobility audit and the 2026-04-23 Seobility full export.
//
// Run: `node src/seeds/updateWhatsAppLinks.js`
const mongoose = require('mongoose');
require('dotenv').config();

const Page = require('../models/pageModel');
const Blog = require('../models/blogModel');
const Product = require('../models/product');
const HeroSlide = require('../models/heroSlideModel');

const OLD_REGEX = /https:\/\/wa\.me\/923122031137/g;
const OLD_REGEX_GENERIC = /https:\/\/wa\.me\//g;
const NEW_PREFIX = 'https://api.whatsapp.com/send?phone=';
const NEW_SPECIFIC = 'https://api.whatsapp.com/send?phone=923122031137';

function rewrite(str) {
  if (typeof str !== 'string' || !str) return { value: str, changed: false };
  let changed = false;
  let next = str;
  if (OLD_REGEX.test(next)) {
    next = next.replace(OLD_REGEX, NEW_SPECIFIC);
    changed = true;
  }
  // Generic wa.me/<number> → api.whatsapp.com/send?phone=<number>
  OLD_REGEX_GENERIC.lastIndex = 0;
  if (OLD_REGEX_GENERIC.test(next)) {
    next = next.replace(/https:\/\/wa\.me\/(\d+)/g, `${NEW_PREFIX}$1`);
    changed = true;
  }
  return { value: next, changed };
}

async function updateCollection(Model, fields, label) {
  let updated = 0;
  const or = fields.map((f) => ({ [f]: { $regex: 'wa\\.me/' } }));
  const docs = await Model.find({ $or: or }).lean(false);
  for (const doc of docs) {
    let docChanged = false;
    for (const field of fields) {
      const current = doc[field];
      if (typeof current !== 'string') continue;
      const { value, changed } = rewrite(current);
      if (changed) {
        doc[field] = value;
        docChanged = true;
      }
    }
    if (docChanged) {
      await doc.save();
      updated += 1;
      console.log(`  Updated ${label}: ${doc.slug || doc._id}`);
    }
  }
  console.log(`${label}: ${updated} updated (of ${docs.length} matched)`);
  return updated;
}

async function run() {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) {
      console.error('MONGO_URI env var is required. Set it in .env or the shell before running.');
      process.exitCode = 1;
      return;
    }
    await mongoose.connect(uri);
    console.log('Connected to MongoDB');

    let total = 0;
    total += await updateCollection(Page, ['content', 'metaDescription'], 'Page');
    total += await updateCollection(Blog, ['content', 'metaDescription'], 'Blog');
    total += await updateCollection(Product, ['description', 'shortDescription'], 'Product');
    total += await updateCollection(HeroSlide, ['description', 'buttonLink', 'secondButtonLink'], 'HeroSlide');

    console.log(`\nDone. ${total} document(s) updated across all collections.`);
  } catch (err) {
    console.error('Error updating WhatsApp links:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

run();
