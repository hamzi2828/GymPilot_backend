// src/seeds/lib/harvestReference.js
//
// Pulls catalogue reference data (titles, fits, sizes, price points, imagery)
// out of the public collection pages used as the design reference, so the
// seeded store has realistic products instead of lorem placeholders.
//
// The reference storefront is a Next.js app: its server-rendered product data
// sits in the React Flight payload inside `self.__next_f.push([1, "..."])`
// script tags. We reassemble that string and brace-match each product object.

const BASE = 'https://squatwolf.com';

/** Reassemble the Flight payload from a page's HTML. */
function flightPayload(html) {
  const re = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g;
  const parts = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      parts.push(JSON.parse(m[1]));
    } catch {
      /* a chunk we can't decode is not fatal — skip it */
    }
  }
  return parts.join('');
}

/** Extract every balanced `{"id":"gid://shopify/Product/...}` object. */
function extractProducts(raw) {
  const marker = '{"id":"gid://shopify/Product/';
  const out = [];
  let from = 0;

  for (;;) {
    const start = raw.indexOf(marker, from);
    if (start < 0) break;
    from = start + marker.length;

    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;

    for (let p = start; p < raw.length && p < start + 200000; p++) {
      const ch = raw[p];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = p + 1; break; }
      }
    }

    if (end < 0) continue;
    try {
      out.push(JSON.parse(raw.slice(start, end)));
    } catch {
      /* truncated object — skip */
    }
  }
  return out;
}

const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const clean = (u) => String(u || '').split('?')[0];

/** Reduce a reference product to just what the seeder needs. */
function slim(p) {
  const images = [
    clean(p.featuredImage?.url || p.featuredImage?.src),
    ...arr(p.images).map((i) => clean(i?.url || i?.src)),
  ].filter(Boolean);

  const sizeOption = arr(p.options).find((o) => /size/i.test(o?.name || ''));

  return {
    handle: p.handle,
    title: p.title,
    productType: p.productType || '',
    fit: p.fit?.value || (typeof p.fit === 'string' ? p.fit : '') || '',
    description: String(p.description || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    tags: arr(p.tags).map(String).slice(0, 10),
    sizes: arr(sizeOption?.values || sizeOption?.optionValues).map((v) => v?.name || v).filter(Boolean),
    price: Math.round(Number(p.priceRange?.minVariantPrice?.amount) || 0),
    compareAt: Math.round(Number(p.compareAtPriceRange?.minVariantPrice?.amount) || 0),
    inventory: Number(p.totalInventory) || 0,
    images: [...new Set(images)].slice(0, 5),
  };
}

/** Fetch one collection page and return its slimmed products. */
async function fetchCollection(handle) {
  const res = await fetch(`${BASE}/collections/${handle}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      Accept: 'text/html',
    },
  });
  if (!res.ok) return [];
  const html = await res.text();
  return extractProducts(flightPayload(html)).map(slim).filter((p) => p.handle && p.images.length);
}

/**
 * Harvest several collections, deduped by handle, tagging each product with
 * every local category slug it belongs to.
 *
 * @param {Record<string,string[]>} collectionMap  referenceHandle -> local category slugs
 */
async function harvest(collectionMap) {
  const byHandle = new Map();

  for (const [handle, localCats] of Object.entries(collectionMap)) {
    let products = [];
    try {
      products = await fetchCollection(handle);
    } catch (err) {
      console.warn(`  ! ${handle}: ${err.message}`);
      continue;
    }
    console.log(`  · ${handle}: ${products.length}`);

    products.forEach((p) => {
      const existing = byHandle.get(p.handle);
      if (existing) {
        existing.categories = [...new Set([...existing.categories, ...localCats])];
      } else {
        byHandle.set(p.handle, { ...p, categories: [...localCats] });
      }
    });
  }

  return [...byHandle.values()];
}

module.exports = { harvest, fetchCollection, extractProducts, flightPayload, slim };
