// The public trainer endpoints, against a real MongoDB: a visitor gets the
// profile the website shows and none of the trainer's own contact details,
// staff account, desk code or pay terms; the admin list still has them.

const assert = require('node:assert/strict');
const h = require('./helpers/harness');

let gym;
let trainers;
let trainer;

const PRIVATE = ['email', 'phone', 'userId', 'staffCode', 'commissionPercent', 'commissionType', 'commissionValue', 'salary', 'salaryCycle'];

const test = h.suite(async () => {
  const Trainer = h.src('gymfolio/models/trainerModel');
  trainers = h.src('gymfolio/controller/trainerController');

  gym = await h.createGym('trainer-public-gym');
  await h.inGym(gym, async () => {
    await h.ensureIndexes(Trainer);
    trainer = await Trainer.create({
      name: 'Tariq Trainer',
      slug: 'tariq-trainer',
      role: 'Strength coach',
      bio: 'Lifts.',
      image: '/uploads/trainer-public-gym/tariq.png',
      email: 'tariq@trainer-private.org',
      phone: '0300 1234567',
      specialties: ['Strength'],
      experience: 6,
      social: { instagram: 'https://instagram.com/tariq' },
      userId: '0000000000000000000000bb',
      staffCode: 'TR-0007',
      commissionType: 'percent',
      commissionValue: 40,
      commissionPercent: 40,
      salary: 50000,
      isActive: true,
      isFeatured: true
    });
  });
});

const call = (handler, req = {}) => h.inGym(gym, () => h.call(handler, req));
const plain = (value) => JSON.parse(JSON.stringify(value));

test('no public trainer read carries contact details, the staff account, the desk code or pay', async () => {
  const reads = [
    ['active', await call(trainers.getActiveTrainers), (body) => body.data[0]],
    ['featured', await call(trainers.getFeaturedTrainers), (body) => body.data[0]],
    ['by id', await call(trainers.getTrainerById, { params: { id: String(trainer._id) } }), (body) => body.data],
    ['by slug', await call(trainers.getTrainerBySlug, { params: { slug: 'tariq-trainer' } }), (body) => body.data]
  ];
  for (const [name, res, pick] of reads) {
    assert.equal(res.statusCode, 200, `${name}: ${JSON.stringify(res.body)}`);
    const shown = plain(pick(res.body));
    for (const field of PRIVATE) assert.equal(field in shown, false, `${name} leaves out ${field}`);
    assert.doesNotMatch(JSON.stringify(shown), /trainer-private|0300 1234567|TR-0007|0000000000000000000000bb/, name);

    // What the website's trainer cards and profile page are built from.
    assert.equal(shown.name, 'Tariq Trainer');
    assert.equal(shown.slug, 'tariq-trainer');
    assert.equal(shown.role, 'Strength coach');
    assert.equal(shown.bio, 'Lifts.');
    assert.equal(shown.image, '/uploads/trainer-public-gym/tariq.png');
    assert.deepEqual(shown.specialties, ['Strength']);
    assert.equal(shown.experience, 6);
    assert.equal(shown.social.instagram, 'https://instagram.com/tariq');
    assert.equal(shown.isActive, true);
  }
});

test('the admin list still has them', async () => {
  const res = await call(trainers.getAllTrainers, { query: { id: String(trainer._id) } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const row = plain(res.body.data[0]);
  assert.equal(row.email, 'tariq@trainer-private.org');
  assert.equal(row.phone, '0300 1234567');
  assert.equal(row.staffCode, 'TR-0007');
  assert.equal(String(row.userId && (row.userId._id || row.userId)), '0000000000000000000000bb');
  assert.equal(row.commissionValue, 40);
  assert.equal(row.salary, 50000);
});

test('a public class read names its instructor without their email or phone', async () => {
  const GymClass = h.src('gymfolio/models/gymClassModel');
  const classes = h.src('gymfolio/controller/gymClassController');
  const gymClass = await h.inGym(gym, () =>
    GymClass.create({
      name: 'Strength basics',
      slug: 'strength-basics',
      description: 'Barbell basics.',
      category: 'Strength',
      isActive: true,
      isFeatured: true,
      schedule: [{ day: 'Monday', startTime: '18:00', endTime: '19:00', instructor: trainer._id }]
    })
  );

  const reads = [
    ['active', await call(classes.getActiveClasses, { query: {} }), (body) => body.data.find((c) => c.slug === 'strength-basics')],
    ['by id', await call(classes.getClassById, { params: { id: String(gymClass._id) } }), (body) => body.data],
    ['by slug', await call(classes.getClassBySlug, { params: { slug: 'strength-basics' } }), (body) => body.data]
  ];
  for (const [name, res, pick] of reads) {
    assert.equal(res.statusCode, 200, `${name}: ${JSON.stringify(res.body)}`);
    const instructor = plain(pick(res.body)).schedule[0].instructor;
    assert.equal(instructor.name, 'Tariq Trainer', name);
    assert.equal(instructor.role, 'Strength coach', name);
    for (const field of PRIVATE) assert.equal(field in instructor, false, `${name} leaves out ${field}`);
    assert.doesNotMatch(JSON.stringify(res.body), /trainer-private|0300 1234567|TR-0007/, name);
  }
});
