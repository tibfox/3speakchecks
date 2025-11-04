const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'threespeak';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'contentcreators';

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB client
let db;

// Connect to MongoDB
async function connectToMongo() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(DATABASE_NAME);
        console.log('Connected to MongoDB successfully');
    } catch (error) {
        console.error('Failed to connect to MongoDB:', error);
        process.exit(1);
    }
}

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'CheckBanned API is running',
        version: '1.0.0',
        endpoints: {
            check: '/check/:username',
            gethive: '/gethive/:user_id',
            getjobid: '/getjobid/:owner/:permlink'
        }
    });
});

// Main endpoint to check if user can post
app.get('/check/:username', async (req, res) => {
    try {
        const { username } = req.params;
        
        if (!username) {
            return res.status(400).json({ 
                error: 'Username is required',
                canPost: false 
            });
        }

        // Query the database
        const collection = db.collection(COLLECTION_NAME);
        const user = await collection.findOne({ username: username });

        if (!user) {
            return res.json({ 
                canPost: false,
                reason: 'User not found'
            });
        }

        // Check if user can post (not banned AND can upload)
        const canPost = !user.banned && user.canUpload === true;

        res.json({ 
            canPost: canPost,
            username: username,
            banned: user.banned,
            canUpload: user.canUpload
        });

    } catch (error) {
        console.error('Error checking user permissions:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            canPost: false 
        });
    }
});

// Endpoint to get hive username from user ID
app.get('/gethive/:user_id', async (req, res) => {
    try {
        const { user_id } = req.params;
        
        if (!user_id) {
            return res.status(400).json({ 
                error: 'User ID is required'
            });
        }

        // Step 1: Find user in users collection
        const usersCollection = db.collection('users');
        const user = await usersCollection.findOne({ user_id: user_id });

        if (!user) {
            return res.json('No user ID found');
        }

        if (!user.last_identity) {
            return res.json('No user ID found');
        }

        // Step 2: Find hive account using last_identity
        const hiveAccountsCollection = db.collection('hiveaccounts');
        
        // Make sure we're using the ObjectId correctly
        let identityId = user.last_identity;
        if (typeof identityId === 'string') {
            identityId = new ObjectId(identityId);
        }
        
        const hiveAccount = await hiveAccountsCollection.findOne({ _id: identityId });

        if (!hiveAccount || !hiveAccount.account) {
            return res.json('No user ID found');
        }

        // Return just the username
        res.json(hiveAccount.account);

    } catch (error) {
        console.error('Error getting hive username:', error);
        res.status(500).json('No user ID found');
    }
});

// Endpoint to get job ID from owner and permlink
app.get('/getjobid/:owner/:permlink', async (req, res) => {
    try {
        const { owner, permlink } = req.params;
        
        if (!owner || !permlink) {
            return res.status(400).json({ 
                error: 'Owner and permlink are required'
            });
        }

        // Query the videos collection
        const videosCollection = db.collection('videos');
        const video = await videosCollection.findOne({ 
            owner: owner, 
            permlink: permlink 
        });

        if (!video) {
            return res.json({ 
                error: 'Video not found'
            });
        }

        if (!video.job_id) {
            return res.json({ 
                error: 'Video not found'
            });
        }

        // Return job ID with context
        res.json({ 
            jobId: video.job_id,
            owner: owner,
            permlink: permlink
        });

    } catch (error) {
        console.error('Error getting job ID:', error);
        res.status(500).json({ 
            error: 'Video not found'
        });
    }
});

// Start server
async function startServer() {
    await connectToMongo();
    
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
        console.log(`Health check: http://localhost:${PORT}`);
        console.log(`Check user: http://localhost:${PORT}/check/{username}`);
    });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    process.exit(0);
});

startServer().catch(console.error);