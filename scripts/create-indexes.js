const { MongoClient } = require('mongodb');
require('dotenv').config({ path: '../.env' });

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'threespeak';

async function createIndex(collection, keys, name) {
    try {
        await collection.createIndex(keys, { name, background: true });
        console.log(`✓ Index created: ${name}`);
    } catch (error) {
        if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
            console.log(`✓ Index already exists: ${name}`);
        } else {
            throw error;
        }
    }
}

async function createIndexes() {
    let client;

    try {
        console.log('Connecting to MongoDB...');
        client = new MongoClient(MONGODB_URI);
        await client.connect();

        const db = client.db(DATABASE_NAME);
        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');
        const watchHistoryCollection = db.collection('watch_history');
        const playlistsCollection = db.collection('playlists');

        console.log('Creating indexes for performance optimization...\n');

        // ============================================================
        // VIDEOS COLLECTION
        // ============================================================
        console.log('=== VIDEOS COLLECTION ===\n');

        // For /feed/:username - filter by owner, sort by date
        await createIndex(videosCollection,
            { owner: 1, created: -1 },
            'owner_created_desc');

        // For /videos/tag/:tag - filter by tag, sort by date
        await createIndex(videosCollection,
            { tags_v2: 1, created: -1 },
            'tags_v2_created_desc');

        // For /feeds/recommended
        await createIndex(videosCollection,
            { recommended: 1, status: 1, created: -1 },
            'recommended_status_created_desc');

        // For /feeds/trending
        await createIndex(videosCollection,
            { trending: 1, status: 1, created: -1 },
            'trending_status_created_desc');

        // For /feeds/first-uploads
        await createIndex(videosCollection,
            { firstUpload: 1, status: 1, created: -1 },
            'firstUpload_status_created_desc');

        // For /api/my-videos
        await createIndex(videosCollection,
            { status: 1, owner: 1, created: -1 },
            'status_owner_created_desc');

        console.log('\nAll indexes on videos collection:');
        const indexes = await videosCollection.indexes();
        indexes.forEach(index => {
            console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
        });

        // ============================================================
        // EMBED-VIDEO COLLECTION
        // ============================================================
        console.log('\n\n=== EMBED-VIDEO COLLECTION ===\n');

        // For /shorts and /shortssorted - includes processed field used in all queries
        await createIndex(embedVideoCollection,
            { short: 1, status: 1, processed: 1, createdAt: -1 },
            'short_status_processed_createdAt_desc');

        // For /shorts?app=xxx and /shortssorted?app=xxx
        await createIndex(embedVideoCollection,
            { short: 1, status: 1, processed: 1, frontend_app: 1, createdAt: -1 },
            'short_status_processed_app_createdAt_desc');

        // For /shorts/:username
        await createIndex(embedVideoCollection,
            { short: 1, status: 1, processed: 1, owner: 1, createdAt: -1 },
            'short_status_processed_owner_createdAt_desc');

        console.log('\nAll indexes on embed-video collection:');
        const embedIndexes = await embedVideoCollection.indexes();
        embedIndexes.forEach(index => {
            console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
        });

        // ============================================================
        // WATCH_HISTORY COLLECTION (also auto-created by playlists Go service)
        // ============================================================
        console.log('\n\n=== WATCH_HISTORY COLLECTION ===\n');

        // For querying user's watch history sorted by last watched
        await createIndex(watchHistoryCollection,
            { username: 1, last_watched_at: -1 },
            'username_lastWatchedAt_desc');

        // For checking if user has watched a specific video
        await createIndex(watchHistoryCollection,
            { username: 1, author: 1, permlink: 1 },
            'username_author_permlink');

        // For getting all viewers of a video
        await createIndex(watchHistoryCollection,
            { author: 1, permlink: 1, last_watched_at: -1 },
            'author_permlink_lastWatchedAt_desc');

        console.log('\nAll indexes on watch_history collection:');
        const watchIndexes = await watchHistoryCollection.indexes();
        watchIndexes.forEach(index => {
            console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
        });

        // ============================================================
        // PLAYLISTS COLLECTION (also auto-created by playlists Go service)
        // ============================================================
        console.log('\n\n=== PLAYLISTS COLLECTION ===\n');

        await createIndex(playlistsCollection,
            { owner: 1 },
            'owner');

        await createIndex(playlistsCollection,
            { access: 1 },
            'access');

        await createIndex(playlistsCollection,
            { owner: 1, created_at: -1 },
            'owner_createdAt_desc');

        await createIndex(playlistsCollection,
            { access: 1, created_at: -1 },
            'access_createdAt_desc');

        // Multikey indexes for video lookup in items array
        await createIndex(playlistsCollection,
            { 'items.author': 1, 'items.permlink': 1 },
            'items_author_permlink');

        await createIndex(playlistsCollection,
            { owner: 1, 'items.author': 1, 'items.permlink': 1 },
            'owner_items_author_permlink');

        await createIndex(playlistsCollection,
            { access: 1, 'items.author': 1, 'items.permlink': 1 },
            'access_items_author_permlink');

        console.log('\nAll indexes on playlists collection:');
        const playlistIndexes = await playlistsCollection.indexes();
        playlistIndexes.forEach(index => {
            console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
        });

        console.log('\n✓ All indexes created successfully!');

    } catch (error) {
        console.error('Error creating indexes:', error);
        process.exit(1);
    } finally {
        if (client) {
            await client.close();
            console.log('\nMongoDB connection closed.');
        }
    }
}

createIndexes();
