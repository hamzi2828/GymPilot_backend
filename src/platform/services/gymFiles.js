// src/platform/services/gymFiles.js
//
// A deleted gym's stored files. Everything a gym uploads lands in the Vercel
// Blob store under `<slug>/` (helper/blobUpload.js folderFor) -- member ID
// scans, medical letters, payment proofs, logos, class photos -- at public
// URLs. Dropping the gym's database forgets those URLs but does not take the
// files down; this does.
//
// Callers go through this module's `store` (never a destructured copy), so a
// test can stand in for the real one.

// Folders files are stored in when there is NO gym in context (a deployment
// from before the platform kept its files at `<folder>/…`). A gym whose slug
// is one of these would share its prefix with them, so its files are never
// removed by prefix -- and provisioning reserves the names, so no new gym
// gets one.
const SHARED_FOLDERS = new Set([
  'uploads', 'settings', 'banks', 'trainers', 'members', 'member-documents', 'payment-proofs',
  'gym-classes', 'products', 'screenshots', 'home-sections', 'home-videos', 'hero-slides', 'testimonials',
  'blogs', 'blog-hero',
  // GymsPilotPro's own bank-account QR codes (services/platformBankAccounts.js).
  'platform-bank-qr'
]);

const PAGE_SIZE = 1000;
// 50,000 files: far more than a gym stores, and a ceiling on one request.
const MAX_PAGES = 50;

const store = {
  configured: (env = process.env) => !!env.BLOB_READ_WRITE_TOKEN,
  list: (options) => require('@vercel/blob').list(options),
  remove: (urls) => require('@vercel/blob').del(urls)
};

/**
 * Removes every file stored under `<slug>/`. Never throws: the gym is
 * already gone by the time this runs, and the answer says what happened --
 * `removed` files, and when the store gave up part-way, `left: true` with
 * the `error`. `skipped` says why nothing was attempted.
 *
 * @returns {Promise<{removed: number, left?: boolean, error?: string, skipped?: string}>}
 */
async function removeGymFiles(slug) {
  const name = String(slug || '').toLowerCase().trim();
  if (!name) return { removed: 0, skipped: 'no slug' };
  if (SHARED_FOLDERS.has(name)) return { removed: 0, skipped: `"${name}" is also a shared folder in the file store` };
  if (!store.configured()) return { removed: 0, skipped: 'no file store on this server' };

  let removed = 0;
  try {
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      // The trailing slash is what keeps `iron/` from matching `iron-works/`.
      const result = await store.list({ prefix: `${name}/`, limit: PAGE_SIZE, cursor });
      const urls = ((result && result.blobs) || []).map((blob) => blob.url).filter(Boolean);
      if (urls.length) {
        await store.remove(urls);
        removed += urls.length;
      }
      if (!result || !result.hasMore || !result.cursor) return { removed };
      cursor = result.cursor;
    }
    return { removed, left: true, error: 'too many files for one run; delete the rest from the file store' };
  } catch (error) {
    console.error(`[platform] could not remove the stored files of deleted gym ${name}:`, error.message);
    return { removed, left: true, error: error.message };
  }
}

module.exports = { removeGymFiles, store, SHARED_FOLDERS };
