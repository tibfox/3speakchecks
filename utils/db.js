const { MongoClient } = require('mongodb');
const { MONGODB_URI, DATABASE_NAME } = require('./config');

let db;

async function connectToMongo() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(DATABASE_NAME);
        console.log('Connected to MongoDB successfully');

        // Create text indexes for search (non-blocking — may take a while on large collections)
        Promise.all([
            db.collection('videos').createIndex(
                { title: 'text', description: 'text', tags_v2: 'text' },
                { name: 'videos_text_search', language_override: '_text_lang' }
            ),
            db.collection('embed-video').createIndex(
                { hive_title: 'text', hive_body: 'text', hive_tags: 'text' },
                { name: 'embed_video_text_search' }
            ),
            db.collection('embed-audio').createIndex(
                { title: 'text', description: 'text', tags: 'text' },
                { name: 'embed_audio_text_search' }
            ),
            db.collection('hivecommunities').createIndex(
                { title: 'text', about: 'text', description: 'text' },
                { name: 'hivecommunities_text_search' }
            ),
        ]).then(() => console.log('Text search indexes ensured'))
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
