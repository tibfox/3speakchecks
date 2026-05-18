/**
 * Backfill hive_tags_lower on embed-video documents.
 *
 * This creates a pre-lowercased copy of hive_tags so tag queries can use a
 * simple equality match instead of $regex, enabling index usage.
 *
 * Safe to run multiple times — skips documents that already have the field.
 *
 * Usage:  node backfill-hive-tags-lower.js
 */
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'threespeak';
const BATCH_SIZE = 500;

async function backfill() {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const col = client.db(DATABASE_NAME).collection('embed-video');

    const total = await col.countDocuments({ hive_tags: { $exists: true }, hive_tags_lower: { $exists: false } });
    console.log(`Documents to backfill: ${total}`);

    let processed = 0;
    const cursor = col.find(
        { hive_tags: { $exists: true }, hive_tags_lower: { $exists: false } },
        { projection: { _id: 1, hive_tags: 1 } }
    ).batchSize(BATCH_SIZE);

    let bulk = [];
    for await (const doc of cursor) {
        const lower = (doc.hive_tags || []).map(t => (typeof t === 'string' ? t.toLowerCase() : String(t)));
        bulk.push({
            updateOne: {
                filter: { _id: doc._id },
                update: { $set: { hive_tags_lower: lower } },
            },
        });
        if (bulk.length >= BATCH_SIZE) {
            await col.bulkWrite(bulk, { ordered: false });
            processed += bulk.length;
            console.log(`  ${processed}/${total}`);
            bulk = [];
        }
    }
    if (bulk.length) {
        await col.bulkWrite(bulk, { ordered: false });
        processed += bulk.length;
    }

    console.log(`Done. Backfilled ${processed} documents.`);
    await client.close();
}

backfill().catch(err => { console.error(err); process.exit(1); });
