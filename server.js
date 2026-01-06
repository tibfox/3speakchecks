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

// View counts cache (5 minute TTL)
const viewsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedViews(key) {
    const cached = viewsCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.views;
    }
    return null;
}

function setCachedViews(key, views) {
    viewsCache.set(key, { views, timestamp: Date.now() });
}

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'CheckBanned API is running',
        version: '1.0.0',
        endpoints: {
            check: '/check/:username',
            gethive: '/gethive/:user_id',
            getjobid: '/getjobid/:owner/:permlink',
            views: 'POST /views',
            myVideos: 'GET /api/my-videos?username={username}'
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

// Endpoint to get user's videos
app.get('/api/my-videos', async (req, res) => {
    try {
        // Extract query parameters
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = parseInt(req.query.offset) || 0;
        const statusFilter = req.query.status || 'all';
        const username = req.query.username;

        if (!username) {
            return res.status(400).json({
                success: false,
                error: 'Username is required'
            });
        }

        // Build query for videos collection
        const videosCollection = db.collection('videos');
        const query = { owner: username };

        // Add status filter if not 'all'
        if (statusFilter !== 'all') {
            query.status = statusFilter;
        }

        // Get total count
        const total = await videosCollection.countDocuments(query);

        // Fetch videos with pagination, sorted by created_at descending, then by _id
        const videosData = await videosCollection
            .find(query)
            .sort({ created_at: -1, _id: -1 })
            .skip(offset)
            .limit(limit)
            .toArray();

        // Transform videos to match required frontend format
        const videos = videosData.map(video => {
            // Determine video_v2 identifier
            const videoId = video.permlink || video.video_id || video._id?.toString();

            return {
                video_id: videoId,
                owner: video.owner,
                author: video.author || video.owner,
                permlink: video.permlink || videoId,
                title: video.title || '',
                body: video.body || video.description || '',
                status: video.status || 'draft',
                publish_type: video.publish_type || (video.status === 'scheduled' ? 'schedule' : 'immediate'),
                publish_data: video.publish_data || (video.scheduled_at ? { scheduled_at: video.scheduled_at } : null),
                created_at: video.created_at || video.createdAt || new Date().toISOString(),
                updated_at: video.updated_at || video.updatedAt || video.created_at || new Date().toISOString(),
                duration: video.duration || video.spkvideo?.duration || 0,
                tags: video.tags || [],
                images: {
                    thumbnail: video.thumbnail || video.images?.thumbnail || `https://img.3speak.tv/${videoId}/thumbnail.png`,
                    poster: video.poster || video.images?.poster || `https://img.3speak.tv/${videoId}/poster.jpg`
                },
                spkvideo: {
                    duration: video.duration || video.spkvideo?.duration || 0,
                    video_v2: videoId
                }
            };
        });

        // Return response
        res.json({
            success: true,
            data: {
                total,
                limit,
                offset,
                videos
            }
        });

    } catch (error) {
        console.error('Error fetching user videos:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch videos'
        });
    }
});

// Endpoint to get batch video view counts
app.post('/views', async (req, res) => {
    try {
        const { videos } = req.body;
        
        // Validate request body
        if (!videos || !Array.isArray(videos)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid request body',
                message: 'videos array is required'
            });
        }
        
        // Check array length limit
        if (videos.length > 50) {
            return res.status(400).json({
                success: false,
                error: 'Too many videos',
                message: 'Maximum 50 videos per request'
            });
        }
        
        // Validate each video has required fields
        for (const video of videos) {
            if (!video.author || !video.permlink) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid request body',
                    message: 'Each video must have author and permlink'
                });
            }
        }
        
        const results = {};
        
        // Fetch all in parallel
        await Promise.all(
            videos.map(async ({ author, permlink }) => {
                const key = `${author}/${permlink}`;
                
                // Check cache first
                const cachedViews = getCachedViews(key);
                if (cachedViews !== null) {
                    results[key] = cachedViews;
                    return;
                }
                
                try {
                    const response = await fetch(
                        `https://3speak.tv/apiv2/@${author}/${permlink}`
                    );
                    if (response.ok) {
                        const data = await response.json();
                        const views = data.views ?? 0;
                        results[key] = views;
                        setCachedViews(key, views);
                    } else {
                        results[key] = null;
                    }
                } catch (err) {
                    console.error(`Error fetching views for ${key}:`, err.message);
                    results[key] = null;
                }
            })
        );
        
        res.json({ success: true, data: results });
        
    } catch (error) {
        console.error('Error fetching view counts:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: 'Failed to fetch view counts'
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