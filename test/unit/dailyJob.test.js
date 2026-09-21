// The daily job's scheduling: which gyms go first, how many run at once,
// where the time budget cuts off, and that gyms side by side stay in their
// own tenant context. No database: the models are stubbed.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gympilot_unit_tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';

// No database in unit tests: never try to build indexes or create collections.
const mongoose = require('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const test = require('node:test');
const assert = require('node:assert/strict');

const Gym = require('../../src/platform/models/gymModel');
const PlatformJobRun = require('../../src/platform/models/platformJobRunModel');
const { runWithTenant, currentTenant } = require('../../src/platform/tenantContext');
const { orderByLastRun, runWithinBudget, dailyJobPace, scheduleActiveGyms, forEachActiveGym } = require('../../src/platform/jobs');

const id = (n) => new mongoose.Types.ObjectId(String(n).padStart(24, '0'));
const gym = (n, slug, extra = {}) => ({ _id: id(n), slug, status: 'active', subscription: { status: 'active' }, database: { name: `gympilot_unit_${slug}` }, ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A gym failing on purpose logs; the test output does not need it.
async function quietly(fn) {
  const error = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
  }
}

test('the pace comes from the env, within sane bounds', () => {
  assert.deepEqual(dailyJobPace({}), { concurrency: 3, budgetMs: 45000 });
  assert.deepEqual(dailyJobPace({ DAILY_JOB_CONCURRENCY: '4', DAILY_JOB_BUDGET_MS: '240000' }), { concurrency: 4, budgetMs: 240000 });
  assert.deepEqual(dailyJobPace({ DAILY_JOB_CONCURRENCY: '0', DAILY_JOB_BUDGET_MS: '5' }), { concurrency: 1, budgetMs: 1000 });
  assert.deepEqual(dailyJobPace({ DAILY_JOB_CONCURRENCY: '500', DAILY_JOB_BUDGET_MS: 'soon' }), { concurrency: 10, budgetMs: 45000 });
});

test('gyms never run come first, then the one whose last run began longest ago; slug breaks ties', () => {
  const gyms = [gym(1, 'alpha'), gym(2, 'bravo'), gym(3, 'charlie'), gym(4, 'delta'), gym(5, 'echo')];
  const runs = [
    { gymId: id(1), lastStartedAt: new Date('2026-09-20T03:00:05Z') },
    { gymId: String(id(2)), lastStartedAt: new Date('2026-09-19T03:00:00Z') },
    { gymId: id(3), lastStartedAt: new Date('2026-09-20T03:00:01Z') },
    { gymId: id(5), lastStartedAt: null }
  ];
  assert.deepEqual(
    orderByLastRun(gyms, runs).map((g) => g.slug),
    ['delta', 'echo', 'bravo', 'charlie', 'alpha']
  );
  // No record at all: alphabetical, as the job always ran.
  assert.deepEqual(orderByLastRun([gyms[2], gyms[0], gyms[1]]).map((g) => g.slug), ['alpha', 'bravo', 'charlie']);
  // The input is not reordered in place.
  assert.equal(gyms[0].slug, 'alpha');
});

test('no new gym is started once the budget is used; the rest are handed back in order', async () => {
  let clock = 0;
  const started = [];
  const deferred = await runWithinBudget(
    ['a', 'b', 'c', 'd', 'e'],
    async (item) => {
      started.push(item);
      await tick();
      clock += 10;
    },
    { concurrency: 1, budgetMs: 25, startedAt: 0, now: () => clock }
  );
  assert.deepEqual(started, ['a', 'b', 'c'], 'c starts at 20ms, inside the budget; d would start at 30ms');
  assert.deepEqual(deferred, ['d', 'e']);
});

test('gyms already running when the budget runs out are left to finish', async () => {
  let clock = 0;
  const finished = [];
  const deferred = await runWithinBudget(
    ['a', 'b', 'c', 'd', 'e', 'f'],
    async (item) => {
      await tick();
      clock += 10;
      finished.push(item);
    },
    { concurrency: 2, budgetMs: 25, startedAt: 0, now: () => clock }
  );
  assert.deepEqual(finished, ['a', 'b', 'c', 'd'], 'd started at 20ms and finished past the budget');
  assert.deepEqual(deferred, ['e', 'f']);
});

test('a run that begins over budget still starts the first gym, so the queue always moves', async () => {
  const started = [];
  const deferred = await runWithinBudget(['a', 'b', 'c'], async (item) => started.push(item), {
    concurrency: 3,
    budgetMs: 1000,
    startedAt: 0,
    now: () => 5000
  });
  assert.deepEqual(started, ['a']);
  assert.deepEqual(deferred, ['b', 'c']);
});

test('never more than `concurrency` gyms at once, and every gym runs exactly once', async () => {
  for (const concurrency of [1, 3, 4, 20]) {
    let active = 0;
    let peak = 0;
    const seen = [];
    const items = Array.from({ length: 11 }, (_, i) => i);
    const deferred = await runWithinBudget(
      items,
      async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        seen.push(item);
        // Uneven work, so lanes free up out of order.
        for (let i = 0; i < (item % 3) + 1; i += 1) await tick();
        active -= 1;
      },
      { concurrency }
    );
    assert.equal(peak, Math.min(concurrency, items.length), `peak at concurrency ${concurrency}`);
    assert.deepEqual(deferred, []);
    assert.deepEqual([...seen].sort((a, b) => a - b), items);
  }
  // Nothing to do is not an error.
  assert.deepEqual(await runWithinBudget([], async () => assert.fail('no items'), { concurrency: 3 }), []);
});

test('gyms running side by side each keep their own tenant context', async () => {
  const connection = { models: {} };
  const gyms = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((slug, i) => gym(i + 1, slug));
  const mismatches = [];
  const seen = [];

  await runWithinBudget(
    gyms,
    (g) =>
      runWithTenant({ gym: g, connection }, async () => {
        for (let step = 0; step < 4; step += 1) {
          // Different delays interleave the gyms' awaits.
          await new Promise((resolve) => setTimeout(resolve, ((g.slug.length + step) % 3) * 2));
          if (currentTenant().slug !== g.slug) mismatches.push(`${g.slug} saw ${currentTenant().slug}`);
        }
        seen.push(g.slug);
      }),
    { concurrency: 3 }
  );

  assert.deepEqual(mismatches, []);
  assert.equal(seen.length, gyms.length);
  assert.equal(currentTenant(), null, 'nothing leaks out of the contexts');
});

/* ------------------------- scheduleActiveGyms, stubbed ------------------------- */

function stubModels({ gyms, runs = [] }) {
  const original = { find: Gym.find, runFind: PlatformJobRun.find, runUpdate: PlatformJobRun.updateOne };
  const calls = { gymFilter: null, runFilter: null, writes: [] };
  const query = (rows) => ({ select: () => query(rows), sort: () => query(rows), lean: async () => rows });

  Gym.find = (filter) => {
    calls.gymFilter = filter;
    return query(gyms.filter((g) => !filter.slug || g.slug === filter.slug));
  };
  PlatformJobRun.find = (filter) => {
    calls.runFilter = filter;
    return query(runs);
  };
  PlatformJobRun.updateOne = async (filter, update, options) => {
    calls.writes.push({ filter, set: update.$set, upsert: options && options.upsert });
    return { acknowledged: true };
  };

  const restore = () => {
    Gym.find = original.find;
    PlatformJobRun.find = original.runFind;
    PlatformJobRun.updateOne = original.runUpdate;
  };
  return { calls, restore };
}

test('the daily run starts with the gyms least recently run, records each one, and reports what the budget left over', async () => {
  const gyms = [
    gym(1, 'alpha'),
    gym(2, 'bravo'),
    gym(3, 'charlie', { subscription: { status: 'expired' } }),
    gym(4, 'delta'),
    gym(5, 'echo')
  ];
  // Yesterday alpha and bravo ran; delta and echo were left over.
  const runs = [
    { gymId: id(1), lastStartedAt: new Date('2026-09-20T03:00:01Z') },
    { gymId: id(2), lastStartedAt: new Date('2026-09-20T03:00:02Z') },
    { gymId: id(4), lastStartedAt: new Date('2026-09-19T03:00:00Z') }
  ];
  const { calls, restore } = stubModels({ gyms, runs });
  const ran = [];
  try {
    // Started long ago against a small budget: only the first gym in line
    // is started.
    const { gyms: results, schedule } = await quietly(() =>
      scheduleActiveGyms(
        async (g) => {
          assert.equal(currentTenant().slug, g.slug);
          ran.push(g.slug);
          if (g.slug === 'echo') throw new Error('SMTP rejected');
          return { sent: 1 };
        },
        { job: 'daily', concurrency: 3, budgetMs: 1000, startedAt: Date.now() - 60000 }
      )
    );

    assert.deepEqual(ran, ['echo'], 'echo has never run, so it goes first');
    assert.deepEqual(calls.gymFilter, { status: 'active' });
    assert.equal(calls.runFilter.job, 'daily');
    assert.deepEqual(Object.keys(results), ['alpha', 'bravo', 'charlie', 'delta', 'echo'], 'answered by slug');
    assert.deepEqual(results.echo, { error: 'SMTP rejected' });
    assert.deepEqual(results.charlie, { skipped: 'subscription inactive' });
    assert.match(results.delta.skipped, /time budget/);
    assert.deepEqual(schedule.deferred, ['delta', 'alpha', 'bravo'], 'the order the next run takes them in');
    assert.equal(schedule.processed, 1);
    assert.equal(schedule.failed, 1);
    assert.equal(schedule.gym, null);
    assert.equal(schedule.budget_ms, 1000);
    assert.equal(typeof schedule.took_ms.echo, 'number');

    // A start before the work and a finish after it, for echo only.
    assert.equal(calls.writes.length, 2);
    const [start, finish] = calls.writes;
    assert.deepEqual(start.filter, { job: 'daily', gymId: id(5) });
    assert.equal(start.upsert, true);
    assert.ok(start.set.lastStartedAt instanceof Date);
    assert.equal(start.set.gymSlug, 'echo');
    assert.ok(finish.set.lastRunAt instanceof Date);
    assert.equal(finish.set.lastOutcome, 'error');
    assert.equal(finish.set.lastError, 'SMTP rejected');
    assert.equal(typeof finish.set.lastDurationMs, 'number');
  } finally {
    restore();
  }
});

test('with time to spare every gym runs, and a dry run writes no record', async () => {
  const gyms = [gym(1, 'alpha'), gym(2, 'bravo'), gym(3, 'charlie')];
  const { calls, restore } = stubModels({ gyms });
  try {
    const { gyms: results, schedule } = await scheduleActiveGyms(async (g) => ({ slug: currentTenant().slug === g.slug }), {
      job: 'daily',
      record: false,
      concurrency: 2,
      budgetMs: 60000
    });
    assert.deepEqual(results, { alpha: { slug: true }, bravo: { slug: true }, charlie: { slug: true } });
    assert.deepEqual(schedule.deferred, []);
    assert.equal(schedule.processed, 3);
    assert.equal(calls.writes.length, 0);
  } finally {
    restore();
  }
});

test('?gym=<slug> runs that gym alone', async () => {
  const gyms = [gym(1, 'alpha'), gym(2, 'bravo')];
  const { calls, restore } = stubModels({ gyms });
  try {
    const { gyms: results, schedule } = await scheduleActiveGyms(async () => ({ ok: true }), { job: 'daily', slug: ' Bravo ', budgetMs: 60000 });
    assert.deepEqual(calls.gymFilter, { status: 'active', slug: 'bravo' });
    assert.deepEqual(results, { bravo: { ok: true } });
    assert.equal(schedule.gym, 'bravo');

    const none = await scheduleActiveGyms(async () => assert.fail('no gym'), { job: 'daily', slug: 'nobody' });
    assert.deepEqual(none.gyms, {});
  } finally {
    restore();
  }
});

test('forEachActiveGym keeps its old answer: { slug: result }, in slug order, nothing recorded', async () => {
  const gyms = [gym(1, 'alpha'), gym(2, 'bravo')];
  const { calls, restore } = stubModels({ gyms });
  try {
    const order = [];
    const results = await forEachActiveGym(async (g) => {
      order.push(g.slug);
      return { n: 1 };
    });
    assert.deepEqual(results, { alpha: { n: 1 }, bravo: { n: 1 } });
    assert.deepEqual(order, ['alpha', 'bravo']);
    assert.equal(calls.runFilter, null, 'no job, no record read');
    assert.equal(calls.writes.length, 0);
  } finally {
    restore();
  }
});
