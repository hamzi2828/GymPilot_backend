// The seed scripts sit in a public repository, so none of them may carry a
// password: it comes from the command line or the environment, or is made
// up for the run. The attendance seeder -- the one that creates desk and
// manager accounts -- is also run here far enough to see it refuse, with a
// database address nothing listens on in case it ever did not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SEEDERS = path.join(ROOT, 'Seeder');

test('no seed script has a password written in it', () => {
  const files = fs.readdirSync(SEEDERS).filter((name) => name.endsWith('.js'));
  assert.ok(files.includes('createAttendance.js') && files.includes('createAdmin.js'));
  for (const name of files) {
    const source = fs.readFileSync(path.join(SEEDERS, name), 'utf8');
    // `password: 'x'`, `PASSWORD = "x"`, `password || 'x'` -- a quoted value
    // given to anything named password.
    const literal = source.match(/password\w*\s*(?:[:=]|\|\||\?\?)\s*['"`][^'"`\s$]+['"`]/i);
    assert.equal(literal, null, `${name}: ${literal && literal[0]}`);
  }
});

function seedAttendance(args, env) {
  return spawnSync(process.execPath, [path.join(SEEDERS, 'createAttendance.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      MONGO_URI: 'mongodb://127.0.0.1:9/gympilot_seed_test_not_a_database',
      SEED_PASSWORD: '',
      ...env
    }
  });
}

test('the attendance seeder still refuses a production database without --force', () => {
  const run = seedAttendance(['--gym', 'nobody'], { NODE_ENV: 'production' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Refusing to seed: NODE_ENV is production/);
});

test('the attendance seeder refuses a password too short to be one', () => {
  for (const [args, env] of [
    [['--gym', 'nobody', '--password', 'abc'], {}],
    [['--gym', 'nobody'], { SEED_PASSWORD: 'abc' }]
  ]) {
    const run = seedAttendance(args, { NODE_ENV: 'development', ...env });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /must be at least 8 characters/);
    assert.doesNotMatch(run.stdout + run.stderr, /abc/, 'and does not print it back');
  }
});
