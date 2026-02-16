const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || 'threespeak';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'contentcreators';
const API_SECRET_KEY = process.env.API_SECRET_KEY;
const ENABLE_MONGO_WRITES = process.env.ENABLE_MONGO_WRITES !== 'false'; // defaults to true
const SHORT_SORT_INTERVAL = parseInt(process.env.SHORT_SORT_INTERVAL) || 2; // days per time bucket
const HIVE_RPC_ENDPOINTS = (process.env.HIVE_RPC_ENDPOINTS || process.env.HIVE_RPC_ENDPOINT || 'https://techcoderx.com,https://api.deathwing.me,https://api.hive.blog')
    .split(',').map(s => s.trim()).filter(Boolean);
const REWARD_WEIGHT = parseFloat(process.env.REWARD_WEIGHT) || 0.7; // weight for reward vs random (0-1, higher = more reward influence)
const RESHARE_WEIGHT = parseFloat(process.env.RESHARE_WEIGHT) || 0.15; // weight for reshare influence (taken from random portion)
const TRENDING_VIEWS_WEIGHT = parseFloat(process.env.TRENDING_VIEWS_WEIGHT) || 1;
const TRENDING_VOTES_WEIGHT = parseFloat(process.env.TRENDING_VOTES_WEIGHT) || 2;
const TRENDING_COMMENTS_WEIGHT = parseFloat(process.env.TRENDING_COMMENTS_WEIGHT) || 3;
const TRENDING_REWARD_WEIGHT = parseFloat(process.env.TRENDING_REWARD_WEIGHT) || 10;
const TRENDING_RESHARE_WEIGHT = parseFloat(process.env.TRENDING_RESHARE_WEIGHT) || 5;
const TRENDING_CANDIDATE_LIMIT = parseInt(process.env.TRENDING_CANDIDATE_LIMIT) || 200;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB client
let db;

/**
 * Middleware to validate API key for protected endpoints
 * Expects API key in Authorization header: 'Bearer YOUR_API_KEY'
 */
function validateApiKey(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
            message: 'API key is required'
        });
    }
    
    // Expected format: "Bearer YOUR_API_KEY"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
            message: 'Invalid authorization format. Use: Bearer YOUR_API_KEY'
        });
    }
    
    const providedKey = parts[1];
    
    if (providedKey !== API_SECRET_KEY) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
            message: 'Invalid API key'
        });
    }
    
    // API key is valid, proceed to the route handler
    next();
}

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

// Hive reward cache (15 minute TTL)
const rewardCache = new Map();
const REWARD_CACHE_TTL = 15 * 60 * 1000;

// Sorted shorts list cache (keyed by "seed|app", 15 minute TTL, max 100 entries)
const sortedShortsCache = new Map();
const SORTED_SHORTS_CACHE_TTL = 15 * 60 * 1000;

// Author reputation cache (8 hour TTL, keyed by author)
const reputationCache = new Map();
const REPUTATION_CACHE_TTL = 8 * 60 * 60 * 1000;

// Follower count cache TTL (4 hours)
const FOLLOWER_CACHE_TTL = 4 * 60 * 60 * 1000;

// Send a batch RPC request, trying each endpoint in order until one succeeds
async function hiveRpcBatch(rpcBatch) {
    for (const endpoint of HIVE_RPC_ENDPOINTS) {
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rpcBatch),
                signal: AbortSignal.timeout(10000)
            });
            const results = await response.json();
            return Array.isArray(results) ? results : [results];
        } catch (error) {
            console.error(`Hive RPC failed for ${endpoint}:`, error.message);
        }
    }
    return []; // all endpoints failed
}

// Convert raw Hive reputation to human-readable score (e.g., 9999999999999 -> ~69)
function hiveReputationToScore(rawReputation) {
    const rep = parseInt(rawReputation);
    if (isNaN(rep) || rep === 0) return 25;
    const neg = rep < 0;
    const absRep = Math.abs(rep);
    let score = Math.log10(absRep) - 9;
    if (score < 0) score = 0;
    score = score * (neg ? -9 : 9) + 25;
    return Math.round(score * 10) / 10;
}

// Fetch Hive reward + content data for sorting — caches reward, title, body, tags (15min TTL)
// Live-changing fields (votes, comments, reputation) come from fetchLivePageData()
async function fetchHiveRewards(authorPerms) {
    const results = new Map(); // key: "author/permlink" -> { reward, title, body, tags }
    const toFetch = [];

    // Check cache first
    for (const { author, permlink } of authorPerms) {
        const key = `${author}/${permlink}`;
        const cached = rewardCache.get(key);
        if (cached && Date.now() - cached.timestamp < REWARD_CACHE_TTL) {
            results.set(key, { reward: cached.reward, title: cached.title || '', body: cached.body || '', tags: cached.tags || [] });
        } else {
            toFetch.push({ author, permlink, key });
        }
    }

    // Batch fetch uncached rewards in groups of 20
    for (let i = 0; i < toFetch.length; i += 20) {
        const batch = toFetch.slice(i, i + 20);
        const rpcBatch = batch.map((item, idx) => ({
            jsonrpc: '2.0',
            id: i + idx,
            method: 'condenser_api.get_content',
            params: [item.author, item.permlink]
        }));

        const resultsArray = await hiveRpcBatch(rpcBatch);

        for (const rpcResult of resultsArray) {
            if (!rpcResult.result) continue;
            const post = rpcResult.result;
            const postKey = `${post.author}/${post.permlink}`;

            const pending = parseFloat(post.pending_payout_value) || 0;
            const paid = parseFloat(post.total_payout_value) || 0;
            const curator = parseFloat(post.curator_payout_value) || 0;
            const reward = pending + paid + curator;

            // Extract content data (title, body, tags) - these rarely change
            const title = post.title || '';
            const body = post.body || '';
            let tags = [];
            try {
                const metadata = JSON.parse(post.json_metadata || '{}');
                tags = Array.isArray(metadata.tags) ? metadata.tags : [];
            } catch (e) { /* ignore */ }

            results.set(postKey, { reward, title, body, tags });
            rewardCache.set(postKey, { reward, title, body, tags, timestamp: Date.now() });

            // Side-effect: refresh reputation cache from the response we already have
            if (!reputationCache.has(post.author) || Date.now() - (reputationCache.get(post.author)?.timestamp || 0) >= REPUTATION_CACHE_TTL) {
                reputationCache.set(post.author, { reputation: hiveReputationToScore(post.author_reputation), timestamp: Date.now() });
            }
        }

        for (const item of batch) {
            if (!results.has(item.key)) {
                results.set(item.key, { reward: 0, title: '', body: '', tags: [] });
            }
        }
    }

    return results;
}

// Fetch live display data for the current page (no cache for post-level data)
// Returns all fields needed for the response: title, body, tags, votes, comments, reward, reputation
// Also refreshes reward + reputation caches as a side effect
async function fetchLivePageData(authorPerms) {
    const results = new Map(); // key: "author/permlink" -> { reward, title, body, tags, votes, comments, author_reputation }

    for (let i = 0; i < authorPerms.length; i += 20) {
        const batch = authorPerms.slice(i, i + 20);
        const rpcBatch = batch.map((item, idx) => ({
            jsonrpc: '2.0',
            id: i + idx,
            method: 'condenser_api.get_content',
            params: [item.author, item.permlink]
        }));

        const resultsArray = await hiveRpcBatch(rpcBatch);

        for (const rpcResult of resultsArray) {
            if (!rpcResult.result) continue;
            const post = rpcResult.result;
            const postKey = `${post.author}/${post.permlink}`;

            const pending = parseFloat(post.pending_payout_value) || 0;
            const paid = parseFloat(post.total_payout_value) || 0;
            const curator = parseFloat(post.curator_payout_value) || 0;
            const reward = pending + paid + curator;

            const title = post.title || '';
            const body = post.body || '';
            const votes = post.net_votes || 0;
            const comments = post.children || 0;
            const author_reputation = hiveReputationToScore(post.author_reputation);

            let tags = [];
            try {
                const metadata = JSON.parse(post.json_metadata || '{}');
                tags = Array.isArray(metadata.tags) ? metadata.tags : [];
            } catch (e) { /* ignore */ }

            results.set(postKey, { reward, title, body, tags, votes, comments, author_reputation });

            // Side-effect: refresh reward + reputation caches (include content data so fetchHiveRewards cache hits retain it)
            rewardCache.set(postKey, { reward, title, body, tags, timestamp: Date.now() });
            reputationCache.set(post.author, { reputation: author_reputation, timestamp: Date.now() });
        }

        for (const item of batch) {
            const key = `${item.author}/${item.permlink}`;
            if (!results.has(key)) {
                results.set(key, { reward: 0, title: '', body: '', tags: [], votes: 0, comments: 0, author_reputation: 25 });
            }
        }
    }

    return results;
}

// Follower count cache (keyed by author, uses FOLLOWER_CACHE_TTL)
const followerCache = new Map();

// Fetch follower counts via RPC in batches of 20
async function fetchFollowerCounts(authors) {
    const results = new Map(); // key: author -> follower_count
    const toFetch = [];

    for (const author of authors) {
        const cached = followerCache.get(author);
        if (cached && Date.now() - cached.timestamp < FOLLOWER_CACHE_TTL) {
            results.set(author, cached.followers);
        } else {
            toFetch.push(author);
        }
    }

    for (let i = 0; i < toFetch.length; i += 20) {
        const batch = toFetch.slice(i, i + 20);
        const rpcBatch = batch.map((author, idx) => ({
            jsonrpc: '2.0',
            id: i + idx,
            method: 'condenser_api.get_follow_count',
            params: [author]
        }));

        const resultsArray = await hiveRpcBatch(rpcBatch);

        for (const rpcResult of resultsArray) {
            if (!rpcResult.result) continue;
            const account = rpcResult.result.account;
            const followers = rpcResult.result.follower_count || 0;
            results.set(account, followers);
            followerCache.set(account, { followers, timestamp: Date.now() });
        }

        for (const author of batch) {
            if (!results.has(author)) {
                results.set(author, 0);
            }
        }
    }

    return results;
}

// Seeded PRNG (mulberry32) - returns a function that produces deterministic 0-1 values
function mulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Following list cache (10 minute TTL)
const followingCache = new Map();
const FOLLOWING_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCachedFollowing(username) {
    const cached = followingCache.get(username);
    if (cached && Date.now() - cached.timestamp < FOLLOWING_CACHE_TTL) {
        return cached.following;
    }
    return null;
}

function setCachedFollowing(username, following) {
    followingCache.set(username, { following, timestamp: Date.now() });
}

// Fetch following list from Hive RPC API (condenser_api.get_following)
async function getFollowingList(username) {
    // Check cache first
    const cached = getCachedFollowing(username);
    if (cached !== null) {
        return cached;
    }

    try {
        const following = [];
        let startFollowing = '';
        const batchSize = 1000;

        // Paginate through the full following list
        while (true) {
            const result = await hiveRpcBatch([{
                jsonrpc: '2.0',
                id: 1,
                method: 'condenser_api.get_following',
                params: [username, startFollowing, 'blog', batchSize]
            }]);

            if (!result || result.length === 0 || !result[0].result) {
                break;
            }

            const batch = result[0].result;
            if (batch.length === 0) break;

            for (const entry of batch) {
                // Skip the startFollowing duplicate on subsequent pages
                if (entry.following === startFollowing) continue;
                following.push(entry.following);
            }

            // If we got fewer than batchSize, we've reached the end
            if (batch.length < batchSize) break;
            startFollowing = batch[batch.length - 1].following;
        }

        if (following.length === 0) {
            console.log(`User ${username} follows nobody or following list is empty`);
            return null;
        }

        // Cache the result
        setCachedFollowing(username, following);
        return following;

    } catch (error) {
        console.error(`Error fetching following list for ${username}:`, error.message);
        return null;
    }
}

// Calculate and flag trending videos
async function calculateAndFlagTrendingVideos() {
    if (!ENABLE_MONGO_WRITES) {
        console.log('Skipping trending calculation (ENABLE_MONGO_WRITES=false)');
        return;
    }
    try {
        console.log('Calculating trending videos...');
        const videosCollection = db.collection('videos');
        
        // Calculate trending over the last 7 days
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        // First, unflag all current trending videos
        await videosCollection.updateMany(
            { trending: true },
            { $set: { trending: false } }
        );
        
        // Calculate trending scores and get top 50 videos
        const trendingVideos = await videosCollection.aggregate([
            {
                $match: {
                    status: 'published',
                    owner: { $ne: 'threespeak-fixer' },
                    created: { $gte: sevenDaysAgo }
                }
            },
            {
                $addFields: {
                    trending_score: {
                        $add: [
                            { $multiply: [{ $ifNull: ['$views', 0] }, TRENDING_VIEWS_WEIGHT] },
                            { $multiply: [{ $ifNull: ['$stats.num_votes', 0] }, TRENDING_VOTES_WEIGHT] },
                            { $multiply: [{ $ifNull: ['$stats.num_comments', 0] }, TRENDING_COMMENTS_WEIGHT] },
                            { $multiply: [{ $ifNull: ['$stats.total_hive_reward', 0] }, TRENDING_REWARD_WEIGHT] }
                        ]
                    }
                }
            },
            {
                $sort: { trending_score: -1 }
            },
            {
                $limit: 50
            }
        ]).toArray();

        // Flag the top 50 as trending
        if (trendingVideos.length > 0) {
            const trendingIds = trendingVideos.map(v => v._id);
            await videosCollection.updateMany(
                { _id: { $in: trendingIds } },
                { $set: { trending: true } }
            );
            console.log(`Flagged ${trendingVideos.length} videos as trending`);
        } else {
            console.log('No trending videos found');
        }
        
    } catch (error) {
        console.error('Error calculating trending videos:', error);
    }
}

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'Pancreas API is running',
        version: '1.3.0',
        endpoints: {
            check: '/check/:username',
            gethive: '/gethive/:user_id',
            getjobid: '/getjobid/:owner/:permlink',
            views: 'POST /views',
            myVideos: 'GET /api/my-videos?username={username}',
            videosByTag: 'GET /videos/tag/:tag?page={page}&limit={limit}',
            feed: 'GET /feed/:username?page={page}&limit={limit}',
            shorts: 'GET /shorts?page={page}&limit={limit}&app={frontend_app}',
            shortsSorted: 'GET /shortssorted?page={page}&limit={limit}&app={frontend_app}&seed={seed}&currentuser={username}',
            updateThumbnail: 'PUT /video/thumbnail (Protected - requires API key)',
            feedRecommended: 'GET /feeds/recommended?page={page}&limit={limit}',
            feedNew: 'GET /feeds/new?page={page}&limit={limit}',
            feedTrending: 'GET /feeds/trending?page={page}&limit={limit}',
            feedFirstUploads: 'GET /feeds/firstUploads?page={page}&limit={limit}'
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

        // Fetch videos with pagination, sorted by created descending (newest first)
        const videosData = await videosCollection
            .find(query)
            .sort({ created: -1, _id: -1 })
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
                created_at: video.created || video.created_at || video.createdAt || new Date().toISOString(),
                updated_at: video.updated_at || video.updatedAt || video.created || new Date().toISOString(),
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

// Endpoint to get videos by tag
app.get('/videos/tag/:tag', async (req, res) => {
    try {
        const { tag } = req.params;
        
        if (!tag) {
            return res.status(400).json({ 
                error: 'Tag is required'
            });
        }

        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;

        // Query the videos collection
        const videosCollection = db.collection('videos');
        
        // Build query to find published videos with the tag in tags_v2 array
        const query = {
            tags_v2: tag.toLowerCase(),
            status: 'published'
        };

        // Get total count for pagination
        const total = await videosCollection.countDocuments(query);
        const totalPages = Math.ceil(total / limit);

        // Fetch videos with pagination, sorted by created descending (newest first)
        const videos = await videosCollection
            .find(query)
            .sort({ created: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Return response
        res.json({
            tag: tag,
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching videos by tag:', error);
        res.status(500).json({ 
            error: 'Internal server error'
        });
    }
});

// Endpoint to get personalized feed based on following list
app.get('/feed/:username', async (req, res) => {
    try {
        const { username } = req.params;
        
        if (!username) {
            return res.status(400).json({ 
                error: 'Username is required'
            });
        }

        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;

        // Get following list from Hive API
        const followingList = await getFollowingList(username);
        
        const videosCollection = db.collection('videos');
        let query = {};
        let feedType = 'personalized';

        // If following list exists and has users, filter by them
        if (followingList && followingList.length > 0) {
            query = { owner: { $in: followingList }, status: 'published' };
            console.log(`Fetching feed for ${username}: ${followingList.length} following`);
        } else {
            // Fallback: return all published videos
            query = { status: 'published' };
            console.log(`Feed fallback for ${username}: showing all videos (no following list)`);
            feedType = 'all';
        }

        // Get total count for pagination
        const total = await videosCollection.countDocuments(query);
        const totalPages = Math.ceil(total / limit);

        // Fetch videos with pagination, sorted by created descending (newest first)
        const videos = await videosCollection
            .find(query)
            .sort({ created: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Return response
        res.json({
            username: username,
            feedType: feedType,
            following: followingList ? followingList.length : 0,
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching feed:', error);
        res.status(500).json({ 
            error: 'Internal server error'
        });
    }
});

// Endpoint to get shorts feed (original)
app.get('/shorts', async (req, res) => {
    try {
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;
        const appFilter = req.query.app; // optional frontend_app filter

        // Query the embed-video collection
        const embedVideoCollection = db.collection('embed-video');

        // Build query for published shorts from last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const query = {
            short: true,
            status: 'published',
            processed: true,
            embed_url: { $exists: true, $ne: null },
            createdAt: { $gte: sevenDaysAgo }
        };

        // Add optional app filter
        if (appFilter) {
            query.frontend_app = appFilter;
            console.log(`Fetching shorts for app: ${appFilter}`);
        }

        // Fetch recent shorts (last 7 days) sorted by newest first
        const shortsData = await embedVideoCollection
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();

        // Deduplicate: Keep only the most recent short for each user+thumbnail combination
        const seenVideos = new Map();
        const deduplicatedShorts = [];

        for (const short of shortsData) {
            const dedupeKey = `${short.owner}|${short.thumbnail_url || 'no-thumb'}`;
            if (!seenVideos.has(dedupeKey) || !short.thumbnail_url) {
                seenVideos.set(dedupeKey, short);
                deduplicatedShorts.push(short);
            }
        }

        // Randomize the order using Fisher-Yates shuffle
        for (let i = deduplicatedShorts.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deduplicatedShorts[i], deduplicatedShorts[j]] = [deduplicatedShorts[j], deduplicatedShorts[i]];
        }

        // Apply pagination to randomized results
        const paginatedShorts = deduplicatedShorts.slice(skip, skip + limit);

        // Get view counts with caching
        const shorts = await Promise.all(
            paginatedShorts.map(async (short) => {
                const key = `${short.owner}/${short.permlink}`;
                let views = getCachedViews(key);
                if (views === null) {
                    views = short.views ?? 0;
                    setCachedViews(key, views);
                }
                return {
                    owner: short.owner,
                    permlink: short.permlink,
                    frontend_app: short.frontend_app,
                    views: views,
                    createdAt: short.createdAt,
                    thumbnail_url: short.thumbnail_url,
                    embed_url: short.embed_url,
                    embed_title: short.embed_title
                };
            })
        );

        const total = deduplicatedShorts.length;
        const totalPages = Math.ceil(total / limit);

        res.json({
            success: true,
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            app: appFilter || 'all',
            shorts: shorts
        });

    } catch (error) {
        console.error('Error fetching shorts:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get all shorts by a specific user, sorted by date descending
// Same response shape as /shortssorted but no weighted scoring, no time window, no dedup
app.get('/shorts/:username', async (req, res) => {
    try {
        const { username } = req.params;
        if (!username || username.length < 1 || username.length > 50) {
            return res.status(400).json({ success: false, error: 'Invalid username' });
        }

        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;

        const embedVideoCollection = db.collection('embed-video');

        // Count total shorts for this user
        const query = {
            short: true,
            status: 'published',
            processed: true,
            embed_url: { $exists: true, $ne: null },
            owner: username
        };

        const [total, shortsData] = await Promise.all([
            embedVideoCollection.countDocuments(query),
            embedVideoCollection
                .find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray()
        ]);

        const totalPages = Math.ceil(total / limit);

        if (shortsData.length === 0) {
            return res.json({
                success: true,
                page,
                limit,
                total,
                totalPages,
                shorts: []
            });
        }

        // Extract author/permlink pairs from embed_url
        const authorPerms = shortsData
            .filter(s => s.embed_url)
            .map(s => {
                const parts = s.embed_url.replace(/^@/, '').split('/');
                return { author: parts[0], permlink: parts[1] };
            });

        // Fetch Hive rewards (for title, body, tags) and live data + followers in parallel
        const uniqueAuthors = [...new Set(authorPerms.map(ap => ap.author))];
        const [hiveRewards, liveData, followerCounts] = await Promise.all([
            fetchHiveRewards(authorPerms),
            fetchLivePageData(authorPerms),
            fetchFollowerCounts(uniqueAuthors)
        ]);

        // Assemble response
        const shorts = await Promise.all(
            shortsData.map(async (short) => {
                const viewKey = `${short.owner}/${short.permlink}`;
                let views = getCachedViews(viewKey);
                if (views === null) {
                    views = short.views ?? 0;
                    setCachedViews(viewKey, views);
                }

                const embedParts = short.embed_url ? short.embed_url.replace(/^@/, '').split('/') : null;
                const rewardData = embedParts ? (hiveRewards.get(`${embedParts[0]}/${embedParts[1]}`) || { reward: 0, title: '', body: '', tags: [] }) : { reward: 0, title: '', body: '', tags: [] };
                const live = embedParts ? (liveData.get(`${embedParts[0]}/${embedParts[1]}`) || { reward: 0, votes: 0, comments: 0, author_reputation: 25 }) : { reward: 0, votes: 0, comments: 0, author_reputation: 25 };
                const followers = embedParts ? (followerCounts.get(embedParts[0]) || 0) : 0;

                return {
                    owner: short.owner,
                    permlink: short.permlink,
                    frontend_app: short.frontend_app,
                    views: views,
                    hive_reward: live.reward || rewardData.reward,
                    hive_title: rewardData.title || short.embed_title || '',
                    hive_body: rewardData.body || '',
                    hive_tags: rewardData.tags || [],
                    hive_votes: live.votes,
                    hive_comments: live.comments,
                    hive_author_reputation: live.author_reputation,
                    hive_followers: followers,
                    createdAt: short.createdAt,
                    thumbnail_url: short.thumbnail_url,
                    embed_url: short.embed_url,
                    embed_title: short.embed_title
                };
            })
        );

        res.json({
            success: true,
            page,
            limit,
            total,
            totalPages,
            shorts
        });

    } catch (error) {
        console.error('Error fetching user shorts:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get sorted shorts feed with reward-weighted bucket sorting
app.get('/shortssorted', async (req, res) => {
    try {
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;
        const appFilter = req.query.app; // optional frontend_app filter
        const currentuser = req.query.currentuser; // optional: filter out shorts this user already watched
        // Seed for deterministic shuffle - use provided seed or generate one
        const seed = req.query.seed ? parseInt(req.query.seed) : Math.floor(Math.random() * 2147483647);

        // Check sorted list cache (keyed by seed+app, stores only lightweight identifiers)
        const cacheKey = `${seed}|${appFilter || 'all'}`;
        let sortedShorts;
        const cached = sortedShortsCache.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < SORTED_SHORTS_CACHE_TTL) {
            sortedShorts = cached.list;
        } else {
            // Full pipeline: MongoDB query → dedup → rewards → filter → score → sort

            // Query the embed-video collection
            const embedVideoCollection = db.collection('embed-video');

            // Build query for published shorts from last 14 days
            const fourteenDaysAgo = new Date();
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

            const query = {
                short: true,
                status: 'published',
                processed: true,
                embed_url: { $exists: true, $ne: null },
                createdAt: { $gte: fourteenDaysAgo }
            };

            // Add optional app filter
            if (appFilter) {
                query.frontend_app = appFilter;
                console.log(`Fetching sorted shorts for app: ${appFilter}`);
            }

            // Fetch recent shorts sorted by newest first
            const shortsData = await embedVideoCollection
                .find(query)
                .sort({ createdAt: -1 })
                .toArray();

            // Deduplicate: Keep only the most recent short for each user+thumbnail combination
            const seenVideos = new Map();
            const deduplicatedShorts = [];

            for (const short of shortsData) {
                const dedupeKey = `${short.owner}|${short.thumbnail_url || 'no-thumb'}`;
                if (!seenVideos.has(dedupeKey) || !short.thumbnail_url) {
                    seenVideos.set(dedupeKey, short);
                    deduplicatedShorts.push(short);
                }
            }

            // Fetch Hive content data via RPC (extract author/permlink from embed_url "@author/permlink")
            const authorPerms = deduplicatedShorts
                .filter(s => s.embed_url)
                .map(s => {
                    const parts = s.embed_url.replace(/^@/, '').split('/');
                    return { author: parts[0], permlink: parts[1] };
                });
            // Fetch reward values for sorting (cached 15min)
            const hiveRewards = await fetchHiveRewards(authorPerms);

            // Attach reward + content data to each short and filter out low-reputation authors
            const filteredShorts = [];
            for (const short of deduplicatedShorts) {
                if (short.embed_url) {
                    const parts = short.embed_url.replace(/^@/, '').split('/');
                    const hiveData = hiveRewards.get(`${parts[0]}/${parts[1]}`) || { reward: 0, title: '', body: '', tags: [] };
                    short.hive_reward = hiveData.reward;
                    short.hive_title = hiveData.title;
                    short.hive_body = hiveData.body;
                    short.hive_tags = hiveData.tags;
                    // Filter out authors with reputation <= 15 (spam/low-quality)
                    const cachedRep = reputationCache.get(parts[0]);
                    if (cachedRep && cachedRep.reputation <= 15) continue;
                } else {
                    short.hive_reward = 0;
                    short.hive_title = '';
                    short.hive_body = '';
                    short.hive_tags = [];
                }
                filteredShorts.push(short);
            }

            // Fetch reshare counts for all filtered shorts in one aggregation query
            const reshareCountMap = new Map();
            const reshareOrConditions = filteredShorts
                .filter(s => s.embed_url)
                .map(s => {
                    const parts = s.embed_url.replace(/^@/, '').split('/');
                    return { author: parts[0], permlink: parts[1] };
                });

            if (reshareOrConditions.length > 0) {
                const resharesCollection = db.collection('reshares');
                const reshareCounts = await resharesCollection.aggregate([
                    { $match: { $or: reshareOrConditions } },
                    { $group: { _id: { author: "$author", permlink: "$permlink" }, count: { $sum: 1 } } }
                ]).toArray();
                for (const rc of reshareCounts) {
                    reshareCountMap.set(`${rc._id.author}/${rc._id.permlink}`, rc.count);
                }
            }

            // Attach reshare counts to shorts
            for (const short of filteredShorts) {
                if (short.embed_url) {
                    const parts = short.embed_url.replace(/^@/, '').split('/');
                    short.reshare_count = reshareCountMap.get(`${parts[0]}/${parts[1]}`) || 0;
                } else {
                    short.reshare_count = 0;
                }
            }

            // Weighted random score sorting
            // sort_score = recencyBonus + reward * REWARD_WEIGHT + reshares * RESHARE_WEIGHT + random * remainder
            const rng = mulberry32(seed);
            const now = new Date();
            const intervalMs = SHORT_SORT_INTERVAL * 24 * 60 * 60 * 1000;
            const randomWeight = Math.max(0, 1 - REWARD_WEIGHT - RESHARE_WEIGHT);

            // Find max reward and max reshares for normalization
            const maxReward = Math.max(...filteredShorts.map(s => s.hive_reward || 0), 0.001);
            const maxReshares = Math.max(...filteredShorts.map(s => s.reshare_count || 0), 1);

            // Assign weighted sort scores
            for (const short of filteredShorts) {
                const normalizedReward = (short.hive_reward || 0) / maxReward;
                const normalizedReshares = (short.reshare_count || 0) / maxReshares;
                const randomComponent = rng();
                // Time bucket bonus: 4 recent buckets (0-8 days) + 1 big bucket (8-14 days)
                const age = now - new Date(short.createdAt);
                const recentBuckets = Math.ceil(8 / SHORT_SORT_INTERVAL); // 4 buckets for first 8 days
                const totalBuckets = recentBuckets + 1; // +1 for the big older bucket
                let bucketIndex = Math.floor(age / intervalMs);
                if (bucketIndex >= recentBuckets) bucketIndex = recentBuckets; // collapse everything 8+ days into one bucket
                const recencyBonus = (totalBuckets - bucketIndex) / totalBuckets; // 1.0 for newest, decreasing

                short.sort_score = recencyBonus + normalizedReward * REWARD_WEIGHT + normalizedReshares * RESHARE_WEIGHT + randomComponent * randomWeight;
            }

            // Sort by score descending
            const scoreSorted = [...filteredShorts].sort((a, b) => b.sort_score - a.sort_score);

            // Remove consecutive shorts by the same author (keep first, skip until a different author appears)
            sortedShorts = [];
            let lastOwner = null;
            for (const short of scoreSorted) {
                if (short.owner !== lastOwner) {
                    // Store identifiers + content data for the cache
                    sortedShorts.push({
                        owner: short.owner,
                        permlink: short.permlink,
                        embed_url: short.embed_url,
                        thumbnail_url: short.thumbnail_url,
                        embed_title: short.embed_title,
                        frontend_app: short.frontend_app,
                        createdAt: short.createdAt,
                        views: short.views,
                        hive_title: short.hive_title || '',
                        hive_body: short.hive_body || '',
                        hive_tags: short.hive_tags || [],
                        reshare_count: short.reshare_count || 0
                    });
                    lastOwner = short.owner;
                }
            }

            // Cache the sorted list (evict expired entries if cache grows too large)
            if (sortedShortsCache.size >= 100) {
                const now = Date.now();
                for (const [k, v] of sortedShortsCache) {
                    if (now - v.timestamp >= SORTED_SHORTS_CACHE_TTL) sortedShortsCache.delete(k);
                }
            }
            sortedShortsCache.set(cacheKey, { list: sortedShorts, timestamp: Date.now() });
        }

        // If currentuser is provided, filter out shorts the user has already watched.
        // Uses _id lookup ($in on primary key) — only checks the shorts in the current list,
        // so performance is independent of how large the user's total watch history is.
        if (currentuser) {
            const watchHistoryCollection = db.collection('watch_history');
            const getHivePermlink = (s) => {
                if (s.embed_url) {
                    const parts = s.embed_url.replace(/^@/, '').split('/');
                    if (parts.length === 2) return parts[1];
                }
                return s.permlink;
            };
            const idsToCheck = sortedShorts.map(s => `${currentuser}:${s.owner}:${getHivePermlink(s)}`);
            const watchedEntries = await watchHistoryCollection
                .find({ _id: { $in: idsToCheck } }, { projection: { _id: 1 } })
                .toArray();
            const watchedSet = new Set(watchedEntries.map(w => w._id));
            sortedShorts = sortedShorts.filter(s => !watchedSet.has(`${currentuser}:${s.owner}:${getHivePermlink(s)}`));
        }

        // Apply pagination to sorted results
        const paginatedShorts = sortedShorts.slice(skip, skip + limit);

        // Fetch all display data for this page only (live from RPC, no post-level cache)
        const pageAuthorPerms = paginatedShorts
            .filter(s => s.embed_url)
            .map(s => {
                const parts = s.embed_url.replace(/^@/, '').split('/');
                return { author: parts[0], permlink: parts[1] };
            });
        const pageUniqueAuthors = [...new Set(pageAuthorPerms.map(ap => ap.author))];
        const [liveData, followerCounts] = await Promise.all([
            fetchLivePageData(pageAuthorPerms),
            fetchFollowerCounts(pageUniqueAuthors)
        ]);

        // Get view counts with caching
        const shorts = await Promise.all(
            paginatedShorts.map(async (short) => {
                const key = `${short.owner}/${short.permlink}`;
                let views = getCachedViews(key);
                if (views === null) {
                    views = short.views ?? 0;
                    setCachedViews(key, views);
                }
                const embedParts = short.embed_url ? short.embed_url.replace(/^@/, '').split('/') : null;
                const data = embedParts ? (liveData.get(`${embedParts[0]}/${embedParts[1]}`) || { reward: 0, votes: 0, comments: 0, author_reputation: 25 }) : { reward: 0, votes: 0, comments: 0, author_reputation: 25 };
                const followers = embedParts ? (followerCounts.get(embedParts[0]) || 0) : 0;
                return {
                    owner: short.owner,
                    permlink: short.permlink,
                    frontend_app: short.frontend_app,
                    views: views,
                    hive_reward: data.reward,
                    hive_title: short.hive_title || '',
                    hive_body: short.hive_body || '',
                    hive_tags: short.hive_tags || [],
                    hive_votes: data.votes,
                    hive_comments: data.comments,
                    hive_author_reputation: data.author_reputation,
                    hive_followers: followers,
                    reshare_count: short.reshare_count || 0,
                    createdAt: short.createdAt,
                    thumbnail_url: short.thumbnail_url,
                    embed_url: short.embed_url,
                    embed_title: short.embed_title
                };
            })
        );

        const total = sortedShorts.length;
        const totalPages = Math.ceil(total / limit);

        // Return response
        res.json({
            success: true,
            seed: seed,
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            app: appFilter || 'all',
            shorts: shorts
        });

    } catch (error) {
        console.error('Error fetching sorted shorts:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to list embed-audio entries
app.get('/audio', async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;

        const audioCollection = db.collection('embed-audio');

        const total = await audioCollection.countDocuments();
        const totalPages = Math.ceil(total / limit);

        const audio = await audioCollection
            .find()
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        res.json({
            success: true,
            page,
            limit,
            total,
            totalPages,
            audio
        });
    } catch (error) {
        console.error('Error fetching audio list:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
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
        const videosCollection = db.collection('videos');
        
        // Fetch all in parallel from MongoDB
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
                    // Query MongoDB directly for view count
                    const video = await videosCollection.findOne(
                        { owner: author, permlink: permlink },
                        { projection: { views: 1 } }
                    );
                    
                    if (video) {
                        const views = video.views ?? 0;
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

// ====== HOMEPAGE FEEDS ======

// Endpoint to get recommended feed
app.get('/feeds/recommended', async (req, res) => {
    try {
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        
        // Query for recommended videos
        const query = { 
            recommended: true,
            status: 'published',
            owner: { $ne: 'threespeak-fixer' }
        };

        // Get total count for pagination
        const total = await videosCollection.countDocuments(query);
        const totalPages = Math.ceil(total / limit);

        // Fetch videos with pagination, sorted by created descending (newest first)
        const videos = await videosCollection
            .find(query)
            .sort({ created: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Return response
        res.json({
            success: true,
            feed: 'recommended',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching recommended feed:', error);
        res.status(500).json({ 
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get new content feed (excludes first uploads)
app.get('/feeds/new', async (req, res) => {
    try {
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        
        // Query for new content (exclude first uploads and trending)
        const query = { 
            status: 'published',
            owner: { $ne: 'threespeak-fixer' },
            firstUpload: { $ne: true },
            trending: { $ne: true }
        };

        // Get total count for pagination
        const total = await videosCollection.countDocuments(query);
        const totalPages = Math.ceil(total / limit);

        // Fetch videos with pagination, sorted by created descending (newest first)
        const videos = await videosCollection
            .find(query)
            .sort({ created: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Return response
        res.json({
            success: true,
            feed: 'new',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching new content feed:', error);
        res.status(500).json({ 
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get trending feed
app.get('/feeds/trending', async (req, res) => {
    try {
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        
        // Query for trending videos
        const query = { 
            trending: true,
            status: 'published',
            owner: { $ne: 'threespeak-fixer' }
        };

        // Get total count for pagination
        const total = await videosCollection.countDocuments(query);
        const totalPages = Math.ceil(total / limit);

        // Fetch videos with pagination, sorted by created descending
        const videos = await videosCollection
            .find(query)
            .sort({ created: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Return response
        res.json({
            success: true,
            feed: 'trending',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching trending feed:', error);
        res.status(500).json({ 
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get trending feed sorted by score with reshare influence
app.get('/feeds/trendingSorted', async (req, res) => {
    try {
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Fetch candidate videos with base score
        const candidateVideos = await videosCollection.aggregate([
            {
                $match: {
                    status: 'published',
                    owner: { $ne: 'threespeak-fixer' },
                    created: { $gte: sevenDaysAgo }
                }
            },
            {
                $addFields: {
                    base_score: {
                        $add: [
                            { $multiply: [{ $ifNull: ['$views', 0] }, TRENDING_VIEWS_WEIGHT] },
                            { $multiply: [{ $ifNull: ['$stats.num_votes', 0] }, TRENDING_VOTES_WEIGHT] },
                            { $multiply: [{ $ifNull: ['$stats.num_comments', 0] }, TRENDING_COMMENTS_WEIGHT] },
                            { $multiply: [{ $ifNull: ['$stats.total_hive_reward', 0] }, TRENDING_REWARD_WEIGHT] }
                        ]
                    }
                }
            },
            { $sort: { base_score: -1 } },
            { $limit: TRENDING_CANDIDATE_LIMIT }
        ]).toArray();

        // Look up embed-video records to get Hive permlinks for reshare matching
        const embedVideoCollection = db.collection('embed-video');
        const embedDocs = candidateVideos.length > 0
            ? await embedVideoCollection.find(
                { $or: candidateVideos.map(v => ({ owner: v.owner, permlink: v.permlink })) },
                { projection: { owner: 1, permlink: 1, embed_url: 1 } }
              ).toArray()
            : [];

        // Build map: "owner/shortPermlink" -> hive permlink from embed_url
        const hivePermlinkMap = new Map();
        for (const doc of embedDocs) {
            if (doc.embed_url) {
                const parts = doc.embed_url.replace(/^@/, '').split('/');
                if (parts.length === 2) {
                    hivePermlinkMap.set(`${doc.owner}/${doc.permlink}`, { author: parts[0], permlink: parts[1] });
                }
            }
        }

        // Fetch reshare counts for candidates
        const reshareCountMap = new Map();
        const reshareOrConditions = candidateVideos
            .map(v => hivePermlinkMap.get(`${v.owner}/${v.permlink}`))
            .filter(Boolean);

        if (reshareOrConditions.length > 0) {
            const resharesCollection = db.collection('reshares');
            const reshareCounts = await resharesCollection.aggregate([
                { $match: { $or: reshareOrConditions } },
                { $group: { _id: { author: "$author", permlink: "$permlink" }, count: { $sum: 1 } } }
            ]).toArray();
            for (const rc of reshareCounts) {
                reshareCountMap.set(`${rc._id.author}/${rc._id.permlink}`, rc.count);
            }
        }

        // Compute final trending score including reshares
        for (const video of candidateVideos) {
            const hivePl = hivePermlinkMap.get(`${video.owner}/${video.permlink}`);
            const reshareCount = hivePl ? (reshareCountMap.get(`${hivePl.author}/${hivePl.permlink}`) || 0) : 0;
            video.reshare_count = reshareCount;
            video.trending_score = video.base_score + reshareCount * TRENDING_RESHARE_WEIGHT;
        }

        // Sort by final score
        candidateVideos.sort((a, b) => b.trending_score - a.trending_score);

        const total = candidateVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = candidateVideos.slice(skip, skip + limit);

        res.json({
            success: true,
            feed: 'trendingSorted',
            page,
            limit,
            total,
            totalPages,
            videos
        });

    } catch (error) {
        console.error('Error fetching trendingSorted feed:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint to get first uploads feed
app.get('/feeds/firstUploads', async (req, res) => {
    try {
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        
        // Query for first time uploads (exclude trending)
        const query = { 
            firstUpload: true,
            status: 'published',
            owner: { $ne: 'threespeak-fixer' },
            trending: { $ne: true }
        };

        // Get total count for pagination
        const total = await videosCollection.countDocuments(query);
        const totalPages = Math.ceil(total / limit);

        // Fetch videos with pagination, sorted by created descending (newest first)
        const videos = await videosCollection
            .find(query)
            .sort({ created: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        // Return response
        res.json({
            success: true,
            feed: 'firstUploads',
            page: page,
            limit: limit,
            total: total,
            totalPages: totalPages,
            videos: videos
        });

    } catch (error) {
        console.error('Error fetching first uploads feed:', error);
        res.status(500).json({ 
            success: false,
            error: 'Internal server error'
        });
    }
});

/**
 * Protected endpoint to update video thumbnail
 * Requires API key authentication via Authorization header
 * 
 * Request body:
 * {
 *   "owner": "username",
 *   "permlink": "video-permlink",
 *   "thumbnail": "ipfs://QmXXXXXX" or "https://example.com/image.jpg"
 * }
 */
app.put('/video/thumbnail', validateApiKey, async (req, res) => {
    if (!ENABLE_MONGO_WRITES) {
        return res.status(503).json({
            success: false,
            error: 'Writes disabled',
            message: 'MongoDB writes are currently disabled (ENABLE_MONGO_WRITES=false)'
        });
    }
    try {
        const { owner, permlink, thumbnail } = req.body;
        
        // Validate required fields
        if (!owner || !permlink || !thumbnail) {
            return res.status(400).json({
                success: false,
                error: 'Invalid request',
                message: 'owner, permlink, and thumbnail are required'
            });
        }
        
        // Validate thumbnail format (basic validation)
        const isValidThumbnail = 
            thumbnail.startsWith('ipfs://') || 
            thumbnail.startsWith('http://') || 
            thumbnail.startsWith('https://');
        
        if (!isValidThumbnail) {
            return res.status(400).json({
                success: false,
                error: 'Invalid thumbnail',
                message: 'Thumbnail must be a valid URL or IPFS CID (starting with ipfs://, http://, or https://)'
            });
        }
        
        // Query the videos collection
        const videosCollection = db.collection('videos');
        const video = await videosCollection.findOne({ 
            owner: owner, 
            permlink: permlink 
        });
        
        if (!video) {
            return res.status(404).json({
                success: false,
                error: 'Video not found',
                message: `No video found for owner: ${owner}, permlink: ${permlink}`
            });
        }
        
        // Update the thumbnail
        const result = await videosCollection.updateOne(
            { owner: owner, permlink: permlink },
            { 
                $set: { 
                    thumbnail: thumbnail,
                    thumbnail_updated_at: new Date()
                } 
            }
        );
        
        if (result.modifiedCount === 0) {
            return res.status(500).json({
                success: false,
                error: 'Update failed',
                message: 'Video found but thumbnail was not updated'
            });
        }
        
        // Log the update for audit purposes
        console.log(`Thumbnail updated for ${owner}/${permlink} to: ${thumbnail}`);
        
        // Return success response
        res.json({
            success: true,
            message: 'Thumbnail updated successfully',
            data: {
                owner: owner,
                permlink: permlink,
                thumbnail: thumbnail,
                updated_at: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('Error updating thumbnail:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: 'Failed to update thumbnail'
        });
    }
});

// Start server
async function startServer() {
    await connectToMongo();
    
    // Initialize trending videos on startup
    console.log('Initializing trending videos...');
    await calculateAndFlagTrendingVideos();
    
    // Schedule trending calculation to run every 15 minutes
    cron.schedule('*/15 * * * *', () => {
        console.log('Running scheduled trending calculation...');
        calculateAndFlagTrendingVideos();
    });
    console.log('Trending calculation scheduled to run every 15 minutes');
    
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