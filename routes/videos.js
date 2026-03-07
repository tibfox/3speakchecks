const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { nsfwFilter, nsfwFilterTags, BANNED_FILTER } = require('../utils/filters');
const { getFollowingList } = require('../utils/hive');
const { getCachedViews, setCachedViews } = require('../utils/cache');
const { validateApiKey } = require('../utils/middleware');
const { ENABLE_MONGO_WRITES } = require('../utils/config');

// Endpoint to get videos by tag
router.get('/videos/tag/:tag', async (req, res) => {
    const db = getDb();
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
            status: 'published',
            ...nsfwFilter(req)
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
router.get('/feed/:username', async (req, res) => {
    const db = getDb();
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
            query = { owner: { $in: followingList }, status: 'published', ...nsfwFilterTags(req) };
            console.log(`Fetching feed for ${username}: ${followingList.length} following`);
        } else {
            // Fallback: return all published videos
            query = { status: 'published', ...nsfwFilterTags(req) };
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

// Endpoint to get video details (reusable flag) from MongoDB
// Supports both 3speak permlink and Hive permlink (via embed_url fallback)
router.get('/api/video/:owner/:permlink', async (req, res) => {
    const db = getDb();
    try {
        const { owner, permlink } = req.params;
        const videosCollection = db.collection('videos');

        // Try direct match (3speak permlink) first
        let video = await videosCollection.findOne(
            { owner, permlink },
            { projection: { reusable: 1, _id: 0 } }
        );

        // Fallback: try matching by embed_url (Hive permlink)
        if (!video) {
            video = await videosCollection.findOne(
                { owner, embed_url: { $regex: `@${owner}/${permlink}$` } },
                { projection: { reusable: 1, _id: 0 } }
            );
        }

        if (!video) {
            return res.status(404).json({ success: false, error: 'Video not found' });
        }

        res.json({ success: true, reusable: video.reusable || false });
    } catch (error) {
        console.error('Error fetching video details:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// PATCH endpoint to set reusable flag on a video
// Protected by UPLOAD_SECRET_TOKEN (same token the frontend uses for uploads)
router.patch('/api/video/:owner/:permlink/reusable', async (req, res) => {
    const db = getDb();
    try {
        // Validate token
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const UPLOAD_SECRET_TOKEN = process.env.UPLOAD_SECRET_TOKEN;

        if (!UPLOAD_SECRET_TOKEN || token !== UPLOAD_SECRET_TOKEN) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const { owner, permlink } = req.params;
        const { reusable } = req.body;

        if (typeof reusable !== 'boolean') {
            return res.status(400).json({ success: false, error: 'reusable must be a boolean' });
        }

        const videosCollection = db.collection('videos');
        const result = await videosCollection.updateOne(
            { owner, permlink },
            { $set: { reusable } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, error: 'Video not found' });
        }

        console.log(`[PATCH reusable] ${owner}/${permlink} → reusable=${reusable}`);
        res.json({ success: true, reusable });
    } catch (error) {
        console.error('Error updating reusable flag:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Endpoint to get batch video view counts
router.post('/views', async (req, res) => {
    const db = getDb();
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

// Endpoint to update video thumbnail
router.put('/video/thumbnail', validateApiKey, async (req, res) => {
    const db = getDb();
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

module.exports = router;
