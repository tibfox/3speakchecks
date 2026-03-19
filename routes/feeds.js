const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { nsfwFilterTags, nsfwFilterHiveTags } = require('../utils/filters');
const { HIDDEN_AUTHORS, TRENDING_CANDIDATE_LIMIT, TRENDING_VIEWS_WEIGHT, TRENDING_VOTES_WEIGHT, TRENDING_COMMENTS_WEIGHT, TRENDING_REWARD_WEIGHT, TRENDING_RESHARE_WEIGHT, RESHARE_WEIGHT } = require('../utils/config');
const { fetchHiveRewards, fetchLivePageData } = require('../utils/hive');

// Endpoint to get recommended feed
router.get('/recommended', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');

        // Query for recommended videos
        const query = {
            recommended: true,
            status: 'published',
            owner: { $nin: HIDDEN_AUTHORS },
            ...nsfwFilterTags(req)
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
router.get('/new', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');

        // Query for new content (exclude first uploads and trending)
        const query = {
            status: 'published',
            owner: { $nin: HIDDEN_AUTHORS },
            firstUpload: { $ne: true },
            trending: { $ne: true },
            publishFailed: { $ne: true },
            ...nsfwFilterTags(req)
        };

        // Fetch legacy and embed videos in parallel
        const [legacyVideos, embedVideosRaw] = await Promise.all([
            videosCollection.find(query).sort({ created: -1 }).limit(limit + skip).toArray(),
            embedVideoCollection.find({
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $nin: [null, ...HIDDEN_AUTHORS] },
                hive_permlink: { $ne: null },
                ...nsfwFilterHiveTags(req)
            }).sort({ createdAt: -1 }).limit(limit + skip).toArray()
        ]);

        // Transform embed videos to match legacy format
        const embedVideos = embedVideosRaw.map(ev => ({
            owner: ev.owner,
            author: ev.hive_author,
            permlink: ev.hive_permlink,
            title: ev.hive_title || ev.originalFilename || '',
            body: ev.hive_body || '',
            status: 'published',
            created: ev.createdAt,
            created_at: ev.createdAt,
            duration: ev.duration || 0,
            tags: ev.hive_tags || [],
            tags_v2: (ev.hive_tags || []).map(t => t.toLowerCase()),
            images: {
                thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
                poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`
            },
            spkvideo: {
                duration: ev.duration || 0,
                video_v2: ev.permlink,
                play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null
            },
            _source: 'embed',
            _sortDate: new Date(ev.createdAt || 0).getTime()
        }));

        // Add sort dates to legacy videos
        const legacyWithDate = legacyVideos.map(v => ({
            ...v,
            _sortDate: new Date(v.created || v.created_at || 0).getTime()
        }));

        // Deduplicate: remove embed videos that already exist in legacy
        const legacyKeys = new Set(legacyWithDate.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbed = embedVideos.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Merge and sort by date descending
        const allVideos = [...legacyWithDate, ...uniqueEmbed];
        allVideos.sort((a, b) => b._sortDate - a._sortDate);

        const total = allVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = allVideos.slice(skip, skip + limit);

        // Clean up internal fields
        videos.forEach(v => { delete v._sortDate; delete v._source; });

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
router.get('/trending', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');

        // Query for trending videos
        const query = {
            trending: true,
            status: 'published',
            owner: { $nin: HIDDEN_AUTHORS },
            ...nsfwFilterTags(req)
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
router.get('/trendingSorted', async (req, res) => {
    try {
        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Fetch legacy candidate videos (without reward in base_score — reward will be fetched live from Hive)
        const [legacyCandidates, embedCandidatesRaw] = await Promise.all([
            videosCollection.aggregate([
                {
                    $match: {
                        status: 'published',
                        owner: { $nin: HIDDEN_AUTHORS },
                        publishFailed: { $ne: true },
                        created: { $gte: sevenDaysAgo },
                        ...nsfwFilterTags(req)
                    }
                },
                {
                    $addFields: {
                        base_score: {
                            $add: [
                                { $multiply: [{ $ifNull: ['$views', 0] }, TRENDING_VIEWS_WEIGHT] },
                                { $multiply: [{ $ifNull: ['$stats.num_votes', 0] }, TRENDING_VOTES_WEIGHT] },
                                { $multiply: [{ $ifNull: ['$stats.num_comments', 0] }, TRENDING_COMMENTS_WEIGHT] }
                            ]
                        }
                    }
                },
                { $sort: { base_score: -1 } },
                { $limit: TRENDING_CANDIDATE_LIMIT }
            ]).toArray(),
            // Fetch published embed videos (non-shorts) from last 7 days with Hive links
            embedVideoCollection.find({
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $ne: null },
                hive_permlink: { $ne: null },
                createdAt: { $gte: sevenDaysAgo },
                ...nsfwFilterHiveTags(req)
            }).sort({ createdAt: -1 }).limit(TRENDING_CANDIDATE_LIMIT).toArray()
        ]);

        // Enrich legacy videos with live Hive reward data (stats.total_hive_reward in MongoDB is unreliable)
        const legacyAuthorPerms = legacyCandidates
            .filter(v => (v.author || v.owner) && v.permlink)
            .map(v => ({ author: v.author || v.owner, permlink: v.permlink }));

        let legacyHiveData = new Map();
        if (legacyAuthorPerms.length > 0) {
            legacyHiveData = await fetchHiveRewards(legacyAuthorPerms);
        }

        // Recalculate base_score for legacy videos with live reward data
        for (const video of legacyCandidates) {
            const hiveKey = `${video.author || video.owner}/${video.permlink}`;
            const hive = legacyHiveData.get(hiveKey);
            const liveReward = hive ? (hive.reward || 0) : 0;
            video.base_score = (video.base_score || 0) + liveReward * TRENDING_REWARD_WEIGHT;
        }

        // Enrich embed videos with Hive data for scoring
        const embedAuthorPerms = embedCandidatesRaw
            .filter(ev => ev.hive_author && ev.hive_permlink)
            .map(ev => ({ author: ev.hive_author, permlink: ev.hive_permlink }));

        let embedHiveData = new Map();
        if (embedAuthorPerms.length > 0) {
            embedHiveData = await fetchHiveRewards(embedAuthorPerms);
        }

        // Transform embed videos into candidate format matching legacy videos
        const embedCandidates = embedCandidatesRaw
            .filter(ev => ev.hive_author && ev.hive_permlink)
            .map(ev => {
                const hiveKey = `${ev.hive_author}/${ev.hive_permlink}`;
                const hive = embedHiveData.get(hiveKey) || { reward: 0, title: '', body: '', tags: [] };
                const base_score = (ev.views || 0) * TRENDING_VIEWS_WEIGHT +
                    (hive.reward || 0) * TRENDING_REWARD_WEIGHT;
                return {
                    owner: ev.owner,
                    author: ev.hive_author,
                    permlink: ev.hive_permlink,
                    title: ev.hive_title || hive.title || '',
                    body: ev.hive_body || hive.body || '',
                    status: 'published',
                    created: ev.createdAt,
                    created_at: ev.createdAt,
                    duration: ev.duration || 0,
                    tags: ev.hive_tags || hive.tags || [],
                    images: {
                        thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
                        poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`
                    },
                    spkvideo: {
                        duration: ev.duration || 0,
                        video_v2: ev.permlink,
                        play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null
                    },
                    stats: {
                        total_hive_reward: hive.reward || 0,
                        num_votes: 0,
                        num_comments: 0
                    },
                    views: ev.views || 0,
                    base_score,
                    _source: 'embed',
                    _embedPermlink: ev.permlink
                };
            });

        // Deduplicate: remove embed videos that already exist in legacy (by hive author+permlink)
        const legacyKeys = new Set(legacyCandidates.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbedCandidates = embedCandidates.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Merge all candidates
        const candidateVideos = [...legacyCandidates, ...uniqueEmbedCandidates];

        // Look up embed-video records to get Hive permlinks for reshare matching (for legacy videos)
        const embedDocs = legacyCandidates.length > 0
            ? await embedVideoCollection.find(
                { $or: legacyCandidates.map(v => ({ owner: v.owner, permlink: v.permlink })) },
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
        // Embed videos already have hive author/permlink directly
        for (const ev of uniqueEmbedCandidates) {
            hivePermlinkMap.set(`${ev.owner}/${ev._embedPermlink || ev.permlink}`, { author: ev.author, permlink: ev.permlink });
        }

        // Fetch reshare counts for all candidates
        const reshareCountMap = new Map();
        const reshareOrConditions = candidateVideos
            .map(v => {
                // For embed candidates, use author/permlink directly (already Hive permlinks)
                if (v._source === 'embed') return { author: v.author, permlink: v.permlink };
                return hivePermlinkMap.get(`${v.owner}/${v.permlink}`);
            })
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
            let hivePl;
            if (video._source === 'embed') {
                hivePl = { author: video.author, permlink: video.permlink };
            } else {
                hivePl = hivePermlinkMap.get(`${video.owner}/${video.permlink}`);
            }
            const reshareCount = hivePl ? (reshareCountMap.get(`${hivePl.author}/${hivePl.permlink}`) || 0) : 0;
            video.reshare_count = reshareCount;
            video.trending_score = (video.base_score || 0) + reshareCount * TRENDING_RESHARE_WEIGHT;
        }

        // Sort by final score
        candidateVideos.sort((a, b) => b.trending_score - a.trending_score);

        const total = candidateVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = candidateVideos.slice(skip, skip + limit);

        // Clean up internal fields
        videos.forEach(v => { delete v._source; delete v._embedPermlink; });

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
router.get('/firstUploads', async (req, res) => {
    try {
        const db = getDb();
        // Extract pagination parameters
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
        const skip = (page - 1) * limit;

        const videosCollection = db.collection('videos');
        const embedVideoCollection = db.collection('embed-video');

        // Query for first time uploads (exclude trending)
        const query = {
            firstUpload: true,
            status: 'published',
            owner: { $nin: HIDDEN_AUTHORS },
            trending: { $ne: true },
            publishFailed: { $ne: true },
            ...nsfwFilterTags(req)
        };

        // Fetch legacy first uploads and embed videos in parallel
        const [legacyVideos, embedVideosRaw] = await Promise.all([
            videosCollection.find(query).sort({ created: -1 }).limit(limit + skip).toArray(),
            embedVideoCollection.find({
                status: 'published',
                short: false,
                listed_on_3speak: true,
                hive_author: { $ne: null },
                hive_permlink: { $ne: null },
                ...nsfwFilterHiveTags(req)
            }).sort({ createdAt: -1 }).limit(200).toArray()
        ]);

        // For embed videos, check if the owner has NO legacy videos (= first upload on 3speak)
        const embedOwners = [...new Set(embedVideosRaw.map(ev => ev.owner))];
        let ownersWithLegacy = new Set();
        let embedCountByOwner = {};
        if (embedOwners.length > 0) {
            // Check for legacy videos
            const existing = await videosCollection.distinct('owner', { owner: { $in: embedOwners } });
            ownersWithLegacy = new Set(existing);

            // Count total listed embed videos per owner (not just the ones in current query)
            const embedCounts = await embedVideoCollection.aggregate([
                { $match: { owner: { $in: embedOwners }, listed_on_3speak: true } },
                { $group: { _id: '$owner', count: { $sum: 1 } } }
            ]).toArray();
            for (const ec of embedCounts) {
                embedCountByOwner[ec._id] = ec.count;
            }
        }

        // Only include embed video if owner has NO legacy videos AND only 1 embed video total
        const firstEmbedByOwner = new Map();
        for (let i = embedVideosRaw.length - 1; i >= 0; i--) {
            const ev = embedVideosRaw[i];
            if (!ownersWithLegacy.has(ev.owner) && (embedCountByOwner[ev.owner] || 0) <= 1) {
                firstEmbedByOwner.set(ev.owner, ev);
            }
        }

        // Transform first-time embed videos
        const embedVideos = [...firstEmbedByOwner.values()].map(ev => ({
            owner: ev.owner,
            author: ev.hive_author,
            permlink: ev.hive_permlink,
            title: ev.hive_title || ev.originalFilename || '',
            body: ev.hive_body || '',
            status: 'published',
            firstUpload: true,
            created: ev.createdAt,
            created_at: ev.createdAt,
            duration: ev.duration || 0,
            tags: ev.hive_tags || [],
            tags_v2: (ev.hive_tags || []).map(t => t.toLowerCase()),
            images: {
                thumbnail: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/thumbnail.png`,
                poster: ev.thumbnail_url || `https://img.3speak.tv/${ev.permlink}/poster.jpg`
            },
            spkvideo: {
                duration: ev.duration || 0,
                video_v2: ev.permlink,
                play_url: ev.manifest_cid ? `https://ipfs.3speak.tv/ipfs/${ev.manifest_cid}` : null
            },
            _sortDate: new Date(ev.createdAt || 0).getTime()
        }));

        // Add sort dates to legacy videos
        const legacyWithDate = legacyVideos.map(v => ({
            ...v,
            _sortDate: new Date(v.created || v.created_at || 0).getTime()
        }));

        // Deduplicate
        const legacyKeys = new Set(legacyWithDate.map(v => `${v.author || v.owner}/${v.permlink}`));
        const uniqueEmbed = embedVideos.filter(ev => !legacyKeys.has(`${ev.author}/${ev.permlink}`));

        // Merge and sort by date descending
        const allVideos = [...legacyWithDate, ...uniqueEmbed];
        allVideos.sort((a, b) => b._sortDate - a._sortDate);

        const total = allVideos.length;
        const totalPages = Math.ceil(total / limit);
        const videos = allVideos.slice(skip, skip + limit);

        // Clean up internal fields
        videos.forEach(v => { delete v._sortDate; });

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

module.exports = router;
