const { MongoClient } = require('mongodb');
require('dotenv').config({ path: '../.env' });

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'threespeak';

async function createIndexes() {
    let client;
    
    try {
        console.log('Connecting to MongoDB...');
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        
        const db = client.db(DATABASE_NAME);
        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');
        
        console.log('Creating indexes for performance optimization...\n');
        
        console.log('=== VIDEOS COLLECTION ===\n');
        
        // Index for owner filtering and created sorting (for feed endpoint)
        console.log('Creating index: { owner: 1, created: -1 }');
        try {
            await videosCollection.createIndex(
                { owner: 1, created: -1 },
                { name: 'owner_created_desc', background: true }
            );
            console.log('✓ Index created: owner_created_desc');
        } catch (error) {
            if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
                console.log('✓ Index already exists: owner_created_desc');
            } else {
                throw error;
            }
        }
        
        // Index for tags_v2 and created sorting (for tag endpoint)
        console.log('\nCreating index: { tags_v2: 1, created: -1 }');
        try {
            await videosCollection.createIndex(
                { tags_v2: 1, created: -1 },
                { name: 'tags_v2_created_desc', background: true }
            );
            console.log('✓ Index created: tags_v2_created_desc');
        } catch (error) {
            if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
                console.log('✓ Index already exists: tags_v2_created_desc');
            } else {
                throw error;
            }
        }
        
        // List all indexes
        console.log('\nAll indexes on videos collection:');
        const indexes = await videosCollection.indexes();
        indexes.forEach(index => {
            console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
        });
        
        // === EMBED-VIDEO COLLECTION INDEXES ===
        console.log('\n\n=== EMBED-VIDEO COLLECTION ===\n');
        
        // Index for shorts: short + status + createdAt (for /shorts endpoint)
        console.log('Creating index: { short: 1, status: 1, createdAt: -1 }');
        try {
            await embedVideoCollection.createIndex(
                { short: 1, status: 1, createdAt: -1 },
                { name: 'short_status_createdAt_desc', background: true }
            );
            console.log('✓ Index created: short_status_createdAt_desc');
        } catch (error) {
            if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
                console.log('✓ Index already exists: short_status_createdAt_desc');
            } else {
                throw error;
            }
        }
        
        // Index for shorts with app filter: short + status + frontend_app + createdAt
        console.log('\nCreating index: { short: 1, status: 1, frontend_app: 1, createdAt: -1 }');
        try {
            await embedVideoCollection.createIndex(
                { short: 1, status: 1, frontend_app: 1, createdAt: -1 },
                { name: 'short_status_app_createdAt_desc', background: true }
            );
            console.log('✓ Index created: short_status_app_createdAt_desc');
        } catch (error) {
            if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
                console.log('✓ Index already exists: short_status_app_createdAt_desc');
            } else {
                throw error;
            }
        }
        
        // List all indexes on embed-video
        console.log('\nAll indexes on embed-video collection:');
        const embedIndexes = await embedVideoCollection.indexes();
        embedIndexes.forEach(index => {
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
