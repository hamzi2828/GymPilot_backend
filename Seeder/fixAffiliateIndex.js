require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI;

(async () => {
  await mongoose.connect(MONGO_URI);
  const users = mongoose.connection.db.collection('users');

  const indexes = await users.indexes();
  const target = indexes.find(i => i.key && i.key['affiliate.code'] === 1);
  if (target) {
    console.log(`Dropping index "${target.name}"...`);
    await users.dropIndex(target.name);
  }

  console.log('Creating partial unique index (only when affiliate.code is a non-empty string)...');
  await users.createIndex(
    { 'affiliate.code': 1 },
    {
      unique: true,
      name: 'affiliate.code_1',
      partialFilterExpression: { 'affiliate.code': { $type: 'string' } }
    }
  );

  const after = await users.indexes();
  const created = after.find(i => i.key && i.key['affiliate.code'] === 1);
  console.log('Final:', JSON.stringify(created, null, 2));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
