// scripts/lib/homeSeed.js
//
// What scripts/cleanHomeSeed.js decides, kept apart from the command line so
// it can be tested: given a gym's homepage sections as they are stored,
// which values are still the text every gym used to be created with, and
// what each becomes.
//
// Until the defaults were rewritten (src/models/homeSectionModel.js), a new
// gym's website opened with claims nobody at that gym had made -- "24/7
// access for members", "Certified coaches on the floor at all times",
// "1200+ Active members" -- and a gallery of stock photographs of somebody
// else's gym. New gyms no longer get the claims; gyms created before still
// have them stored, word for word, wherever the owner never rewrote them.
//
// The one rule: a value is replaced ONLY while it is still exactly what was
// seeded. Anything a gym has edited -- a heading, one bullet of three, one
// figure of four -- is theirs and is left as it is. So:
//
//   * a piece of text that is still the old seed becomes the new default;
//   * a seeded bullet becomes the new default bullet in the same place;
//   * a seeded figure (stats band) or percentage bar (about) is removed --
//     there is no true default for a number -- and a stats band left with
//     no figures is switched off, as it now ships;
//   * a stock photograph is removed from the gallery, and a gallery group
//     left with no photos goes with it. The gym's own photos stay.
//
// OLD below is history, copied from the model as it stood before the
// rewrite (git show fb19c61^:src/models/homeSectionModel.js). It must not be
// "kept up to date": it is what is being looked for.

const OLD = {
  about: {
    heading: 'The best fitness gym in town',
    description:
      'A full strength and conditioning floor, a dedicated studio for group classes, and coaches who actually watch your form. Whether you are lifting for the first time or chasing a personal best, you get a plan built around your goal, not a generic programme handed to everyone who walks in.',
    secondHeading: 'Strength that shows',
    secondDescription:
      'Strength work is the fastest route to a body that performs as well as it looks. Our coaches build progressive lifting blocks around squat, hinge, push and pull, then track your numbers week to week so the progress is something you can see rather than something you hope for.'
  },
  classes: {
    description:
      'Classes run from sunrise to late evening and are capped so nobody trains unwatched. Strength, conditioning, mobility and recovery sessions, each with a scaled option so beginners and regulars can share the same floor.'
  },
  videos: {
    description:
      'Walk the gym before you ever set foot in it — classes mid-session, coaching on the floor and the community that keeps people coming back.'
  },
  trainers: {
    heading: 'Coaches who train you like an athlete',
    description:
      'Every coach on the floor is certified, insured and has come up through the same programmes they now teach. Book an intro session and you will be paired with the one whose speciality matches what you are training for.'
  },
  testimonials: {
    description: 'Real progress, told by the people who made it. Every review below comes from a member training on this floor right now.'
  },
  contact: {
    description:
      'Tell us what you are training for and we will point you at the right membership, class or coach. No hard sell, and no obligation to sign up on the spot.'
  }
};

// about.bullets, in the order they were seeded: each is replaced by the new
// default bullet at the same position.
const OLD_BULLETS = [
  'Open 7 days, with 24/7 access for members',
  'Certified coaches on the floor at all times',
  'Programmes tracked and reviewed every month'
];

// about.progress: percentages of nothing in particular.
const OLD_PROGRESS = [
  { label: 'Strength & Conditioning', value: 85 },
  { label: 'Muscle Tone', value: 90 }
];

// stats.items: the figures.
const OLD_STATS = [
  { value: '1200', suffix: '+', label: 'Active members' },
  { value: '15', suffix: '+', label: 'Certified coaches' },
  { value: '40', suffix: '+', label: 'Classes every week' },
  { value: '10', suffix: 'yrs', label: 'Coaching experience' }
];

// gallery.groups[].images: the stock photographs, by address and caption.
const STOCK_PHOTOS = [
  { src: 'https://images.unsplash.com/photo-1574680096145-d05b474e2155?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80', alt: 'Strength workout session' },
  { src: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80', alt: 'Gym equipment and weights' },
  { src: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80', alt: 'Personal training session' },
  { src: 'https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80', alt: 'Barbell training' },
  { src: 'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80', alt: 'Cardio workout equipment' },
  { src: 'https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80', alt: 'Conditioning session' }
];

const text = (value) => (typeof value === 'string' ? value.trim() : null);

/** Whether `value` is still exactly the seeded text (spaces at the ends aside). */
function isSeedText(value, seeded) {
  return text(value) !== null && text(value) === seeded;
}

function isSeedStat(item) {
  if (!item || typeof item !== 'object') return false;
  return OLD_STATS.some(
    (old) => String(item.value ?? '').trim() === old.value && String(item.suffix ?? '').trim() === old.suffix && text(item.label) === old.label
  );
}

function isSeedProgress(item) {
  if (!item || typeof item !== 'object') return false;
  return OLD_PROGRESS.some((old) => text(item.label) === old.label && Number(item.value) === old.value);
}

function isStockPhoto(image) {
  if (!image || typeof image !== 'object') return false;
  return STOCK_PHOTOS.some((stock) => text(image.src) === stock.src && String(image.alt ?? '').trim() === stock.alt);
}

/**
 * What cleaning one section would change.
 *
 * @param {{ key: string, enabled?: boolean, content?: object }} section  as stored
 * @param {object} defaults  the section's current default content
 *   (HomeSection.DEFAULT_SECTIONS), which is what seeded text becomes
 * @returns {{ changes: Array<{ field: string, was: string, now: string }>, set: object }}
 *   `changes` for the report, in plain words; `set` the update to make
 *   ($set paths). Both empty when the section holds nothing of the old seed.
 */
function planSection(section, defaults = {}) {
  const changes = [];
  const set = {};
  const key = section && section.key;
  const content = (section && section.content) || {};

  // Text that is still the seed.
  for (const [field, seeded] of Object.entries(OLD[key] || {})) {
    if (!isSeedText(content[field], seeded)) continue;
    const now = typeof defaults[field] === 'string' ? defaults[field] : '';
    changes.push({ field, was: seeded, now });
    set[`content.${field}`] = now;
  }

  if (key === 'about') {
    if (Array.isArray(content.bullets)) {
      const fresh = Array.isArray(defaults.bullets) ? defaults.bullets : [];
      let touched = false;
      const bullets = [];
      content.bullets.forEach((bullet, index) => {
        const at = OLD_BULLETS.indexOf(text(bullet));
        if (at < 0) return bullets.push(bullet);
        touched = true;
        const now = typeof fresh[at] === 'string' ? fresh[at] : '';
        changes.push({ field: `bullets[${index}]`, was: OLD_BULLETS[at], now: now || '(removed)' });
        // A seeded claim with nothing to put in its place is taken out.
        if (now) bullets.push(now);
        return undefined;
      });
      if (touched) set['content.bullets'] = bullets;
    }
    if (Array.isArray(content.progress) && content.progress.some(isSeedProgress)) {
      for (const bar of content.progress.filter(isSeedProgress)) {
        changes.push({ field: 'progress', was: `${bar.label} ${bar.value}%`, now: '(removed)' });
      }
      set['content.progress'] = content.progress.filter((bar) => !isSeedProgress(bar));
    }
  }

  if (key === 'stats' && Array.isArray(content.items) && content.items.some(isSeedStat)) {
    for (const item of content.items.filter(isSeedStat)) {
      changes.push({ field: 'items', was: `${item.value}${item.suffix || ''} ${item.label}`, now: '(removed)' });
    }
    const own = content.items.filter((item) => !isSeedStat(item));
    set['content.items'] = own;
    // Nothing of the gym's own to show: hidden, as the band now ships.
    if (!own.length && section.enabled !== false) {
      changes.push({ field: 'enabled', was: 'shown', now: 'hidden until the gym enters its own figures' });
      set.enabled = false;
    }
  }

  if (key === 'gallery' && Array.isArray(content.groups)) {
    let removed = 0;
    const groups = [];
    for (const group of content.groups) {
      const images = Array.isArray(group && group.images) ? group.images : [];
      const own = images.filter((image) => !isStockPhoto(image));
      const dropped = images.length - own.length;
      if (!dropped) {
        groups.push(group);
        continue;
      }
      removed += dropped;
      const title = String((group && group.title) || 'untitled');
      if (own.length) {
        changes.push({ field: `groups "${title}"`, was: `${dropped} stock photo(s)`, now: `(removed; ${own.length} of the gym's own kept)` });
        groups.push({ ...group, images: own });
      } else {
        // Nothing but stock photos in it: an empty tab would be all that is left.
        changes.push({ field: `groups "${title}"`, was: `${dropped} stock photo(s)`, now: '(removed, and the group with them)' });
      }
    }
    if (removed) set['content.groups'] = groups;
  }

  return { changes, set };
}

/**
 * planSection for every section of a gym.
 *
 * @param {Array<object>} sections      the gym's home_sections rows
 * @param {Array<object>} defaultList   HomeSection.DEFAULT_SECTIONS
 * @returns {Array<{ _id, key, changes, set }>}  only the sections that change
 */
function planGym(sections, defaultList = []) {
  const defaults = new Map((defaultList || []).map((section) => [section.key, section.content || {}]));
  const plans = [];
  for (const section of sections || []) {
    const plan = planSection(section, defaults.get(section.key));
    if (plan.changes.length) plans.push({ _id: section._id, key: section.key, ...plan });
  }
  return plans;
}

/**
 * Plans the current gym's clean-up and, with `apply`, makes it. Reads the
 * sections as they are stored and seeds nothing: a gym with no sections yet
 * gets today's defaults the first time its homepage is read.
 *
 * @param {object} HomeSection  the model, in the gym's context
 * @returns {Promise<{ plans: Array, count: number, applied: boolean }>}
 *   `count` is the number of values that are (or would be) changed
 */
async function cleanHomeSeed(HomeSection, { apply = false } = {}) {
  const sections = await HomeSection.find({}).sort({ order: 1 }).lean();
  const plans = planGym(sections, HomeSection.DEFAULT_SECTIONS);
  if (apply) {
    for (const plan of plans) await HomeSection.updateOne({ _id: plan._id }, { $set: plan.set });
  }
  return { plans, count: plans.reduce((sum, plan) => sum + plan.changes.length, 0), applied: !!apply };
}

module.exports = { OLD, OLD_BULLETS, OLD_PROGRESS, OLD_STATS, STOCK_PHOTOS, planSection, planGym, cleanHomeSeed };
