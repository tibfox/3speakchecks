// One-off READ-ONLY lookup: locate sergiomendes/a7569e2e across the video
// collections and print its title-related fields. No writes.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

const OWNER = 'sergiomendes';
const PERMLINK = 'a7569e2e';

(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DATABASE_NAME);

  for (const coll of ['videos', 'embed-video']) {
    const q = {
      $or: [
        { owner: OWNER, permlink: PERMLINK },
        { hive_author: OWNER, hive_permlink: PERMLINK },
      ],
    };
    const docs = await db.collection(coll).find(q).project({
      _id: 1, owner: 1, permlink: 1, hive_author: 1, hive_permlink: 1,
      title: 1, hive_title: 1, embed_title: 1, originalFilename: 1, status: 1,
    }).toArray();
    console.log(`\n=== ${coll}: ${docs.length} match(es) ===`);
    for (const d of docs) console.log(JSON.stringify(d, null, 2));
  }

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
