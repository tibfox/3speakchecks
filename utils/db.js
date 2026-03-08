const { MongoClient } = require('mongodb');
const { MONGODB_URI, DATABASE_NAME } = require('./config');
const searchWeights = require('../config/search-weights.json');

let db;

async function ensureTextIndex(collectionName, config) {
    const col = db.collection(collectionName);
    const fields = {};
    const weights = {};
    for (const [field, weight] of Object.entries(config.fields)) {
        fields[field] = 'text';
        weights[field] = weight;
    }
    const opts = { name: config.indexName, weights };
    if (config.languageOverride) opts.language_override = config.languageOverride;

    try {
        await col.createIndex(fields, opts);
    } catch (err) {
        if (err.codeName === 'IndexOptionsConflict' || err.code === 85) {
            console.log(`Recreating text index on ${collectionName}...`);
            // Drop any existing text index (only one allowed per collection)
            const indexes = await col.indexes();
            for (const idx of indexes) {
                if (idx.textIndexVersion) {
                    await col.dropIndex(idx.name);
                    break;
                }
            }
            await col.createIndex(fields, opts);
        } else {
            throw err;
        }
    }
}

async function connectToMongo() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(DATABASE_NAME);
        console.log('Connected to MongoDB successfully');

        // Create text indexes for search (non-blocking — may take a while on large collections)
        Promise.all(
            Object.values(searchWeights).map(config =>
                ensureTextIndex(config.collection, config)
            )
        ).then(() => console.log('Text search indexes ensured'))
          .catch(err => console.error('Text index creation failed:', err.message));
    } catch (error) {
        console.error('Failed to connect to MongoDB:', error);
        process.exit(1);
    }
}

function getDb() {
    return db;
}

module.exports = { connectToMongo, getDb };
