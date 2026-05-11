const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { nsfwFilter } = require('../utils/filters');

// Treat docs with no category as `voice_message` — the default snap-style
// upload doesn't always set the field. Filtering for voice should catch them.
function applyCategoryFilter(query, value) {
    if (!value) return;
    if (value === 'voice_message') {
        query.$and = (query.$and || []).concat([
            { $or: [{ category: 'voice_message' }, { category: null }, { category: { $exists: false } }] },
        ]);
    } else {
        query.category = value;
    }
}

function categoryMatchClause(value) {
    if (value === 'voice_message') {
        return { $or: [{ category: 'voice_message' }, { category: null }, { category: { $exists: false } }] };
    }
    return { category: value };
}

// Aggregation stages that enrich each audio doc with `playlist_thumbnail` —
// the cover of the earliest-created playlist that contains the audio's
// (owner, post_permlink) tuple. Uploaders sometimes publish a track straight
// into an album playlist; this lets the tile fall back to the album art
// when the audio itself has no thumbnail set.
const playlistJoin = [
    {
        $lookup: {
            from: 'playlists',
            let: { audioOwner: '$owner', audioPermlink: '$post_permlink' },
            pipeline: [
                {
                    $match: {
                        thumbnail: { $exists: true, $ne: '' },
                        $expr: {
                            $and: [
                                { $ne: ['$$audioPermlink', null] },
                                { $anyElementTrue: {
                                    $map: {
                                        input: { $ifNull: ['$items', []] },
                                        as: 'it',
                                        in: { $and: [
                                            { $eq: ['$$it.author', '$$audioOwner'] },
                                            { $eq: ['$$it.permlink', '$$audioPermlink'] },
                                        ]}
                                    }
                                }}
                            ]
                        }
                    }
                },
                { $sort: { created_at: 1 } },
                { $limit: 1 },
                { $project: { thumbnail: 1, _id: 0 } }
            ],
            as: '_playlist'
        }
    },
    {
        $addFields: {
            playlist_thumbnail: { $arrayElemAt: ['$_playlist.thumbnail', 0] }
        }
    },
    { $project: { _playlist: 0 } }
];

// Build a Mongo permlink filter from one or more auto-tag names (OR semantics).
// Returns null if no valid tags. Always queries the subtitles-tags collection.
async function autoTagPermlinkFilter(db, raw) {
    if (!raw) return null;
    const list = (Array.isArray(raw) ? raw : [raw])
        .map(t => String(t).trim().toLowerCase())
        .filter(Boolean);
    if (list.length === 0) return null;
    const escaped = list.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = `(^|,)\\s*(${escaped.join('|')})\\s*(,|$)`;
    const tagDocs = await db.collection('subtitles-tags').find({
        tags: { $regex: regex, $options: 'i' }
    }).project({ permlink: 1 }).toArray();
    return { $in: tagDocs.map(d => d.permlink) };
}

// GET /audio — list audio with optional filters
router.get('/', async (req, res) => {
    try {
        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;

        const audioCollection = db.collection('embed-audio');

        const audioQuery = {
            status: 'published',
            ...nsfwFilter(req)
        };

        // Category filter (voice_message, podcast, audiobook, song, interview)
        applyCategoryFilter(audioQuery, req.query.category);

        // Genre filter (matches the `genre` field if set, else a case-insensitive
        // tag — old data without a genre field still benefits from any tag write).
        if (req.query.genre) {
            const g = String(req.query.genre).trim();
            if (g) {
                const escaped = g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`^${escaped}$`, 'i');
                audioQuery.$and = (audioQuery.$and || []).concat([
                    { $or: [{ genre: regex }, { tags: regex }] },
                ]);
            }
        }

        // Tag filter
        if (req.query.tag) {
            audioQuery.tags = req.query.tag;
        }

        // Owner filter
        if (req.query.owner) {
            audioQuery.owner = req.query.owner;
        }

        // Exact-permlink lookup (used to resolve audio docs for playlist items, etc.)
        if (req.query.permlink) {
            audioQuery.permlink = req.query.permlink;
        }

        // Date filter (ISO string or days-ago shorthand)
        if (req.query.from) {
            const from = req.query.from;
            // If numeric, treat as "days ago"
            const days = parseInt(from);
            if (!isNaN(days) && days > 0) {
                audioQuery.createdAt = { $gte: new Date(Date.now() - days * 86400000) };
            } else {
                audioQuery.createdAt = { $gte: new Date(from) };
            }
        }

        // Auto-tag filter (from subtitles-tags). Accepts a single string or repeated values
        // (e.g. ?auto_tag=news&auto_tag=tech) — matched with OR semantics.
        const autoTagFilter = await autoTagPermlinkFilter(db, req.query.auto_tag);
        if (autoTagFilter) audioQuery.permlink = autoTagFilter;

        // Duration filter (seconds)
        const minDur = parseInt(req.query.min_duration);
        const maxDur = parseInt(req.query.max_duration);
        if ((!isNaN(minDur) && minDur > 0) || (!isNaN(maxDur) && maxDur > 0)) {
            audioQuery.duration = {};
            if (!isNaN(minDur) && minDur > 0) audioQuery.duration.$gte = minDur;
            if (!isNaN(maxDur) && maxDur > 0) audioQuery.duration.$lte = maxDur;
        }

        // Search by title/description
        if (req.query.q) {
            const search = req.query.q.trim();
            audioQuery.$or = [
                { title: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
                { owner: { $regex: search, $options: 'i' } },
            ];
        }

        // Sort: plays (popular), createdAt (newest), duration
        let sort = { createdAt: -1 };
        if (req.query.sort === 'popular') sort = { plays: -1, createdAt: -1 };
        if (req.query.sort === 'longest') sort = { duration: -1 };
        if (req.query.sort === 'shortest') sort = { duration: 1 };

        const total = await audioCollection.countDocuments(audioQuery);
        const totalPages = Math.ceil(total / limit);

        // Always use aggregate to join subtitle languages from subtitles collection
        const pipeline = [
            { $match: audioQuery },
            { $sort: sort },
            { $skip: skip },
            { $limit: limit },
            // Join subtitles — extract available language keys
            {
                $lookup: {
                    from: 'subtitles',
                    let: { perm: '$permlink' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$permlink', '$$perm'] } } },
                        { $project: { subtitles: 1, _id: 0 } }
                    ],
                    as: '_subs'
                }
            },
            {
                $addFields: {
                    subtitle_languages: {
                        $cond: {
                            if: { $gt: [{ $size: '$_subs' }, 0] },
                            then: { $objectToArray: { $arrayElemAt: ['$_subs.subtitles', 0] } },
                            else: []
                        }
                    }
                }
            },
            {
                $addFields: {
                    subtitle_languages: { $map: { input: '$subtitle_languages', as: 'l', in: '$$l.k' } }
                }
            },
            { $project: { _subs: 0 } },
            ...playlistJoin
        ];

        // Optionally join auto-generated tags from subtitles-tags
        if (req.query.include_auto_tags === 'true') {
            pipeline.push(
                {
                    $lookup: {
                        from: 'subtitles-tags',
                        let: { perm: '$permlink' },
                        pipeline: [
                            { $match: { $expr: { $eq: ['$permlink', '$$perm'] } } },
                            { $project: { tags: 1, _id: 0 } }
                        ],
                        as: '_autoTags'
                    }
                },
                {
                    $addFields: {
                        auto_tags: {
                            $cond: {
                                if: { $gt: [{ $size: '$_autoTags' }, 0] },
                                then: { $arrayElemAt: ['$_autoTags.tags', 0] },
                                else: null
                            }
                        }
                    }
                },
                { $project: { _autoTags: 0 } }
            );
        }

        const audio = await audioCollection.aggregate(pipeline).toArray();

        res.json({
            page,
            limit,
            total,
            totalPages,
            audio
        });
    } catch (error) {
        console.error('Error fetching audio:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/grouped — returns audio grouped by category (for homepage-like layout)
router.get('/grouped', async (req, res) => {
    try {
        const db = getDb();
        const audioCollection = db.collection('embed-audio');
        const perGroup = Math.min(parseInt(req.query.limit) || 10, 30);

        // Optional date filter
        const baseMatch = { status: 'published' };
        if (req.query.from) {
            const days = parseInt(req.query.from);
            if (!isNaN(days) && days > 0) {
                baseMatch.createdAt = { $gte: new Date(Date.now() - days * 86400000) };
            }
        }

        // Duration filter (seconds)
        const minDur = parseInt(req.query.min_duration);
        const maxDur = parseInt(req.query.max_duration);
        if ((!isNaN(minDur) && minDur > 0) || (!isNaN(maxDur) && maxDur > 0)) {
            baseMatch.duration = {};
            if (!isNaN(minDur) && minDur > 0) baseMatch.duration.$gte = minDur;
            if (!isNaN(maxDur) && maxDur > 0) baseMatch.duration.$lte = maxDur;
        }

        const categories = ['podcast', 'voice_message', 'song', 'audiobook', 'interview'];
        const groups = {};

        // Shared pipeline stages to join subtitle languages
        const subtitleJoin = [
            {
                $lookup: {
                    from: 'subtitles',
                    let: { perm: '$permlink' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$permlink', '$$perm'] } } },
                        { $project: { subtitles: 1, _id: 0 } }
                    ],
                    as: '_subs'
                }
            },
            {
                $addFields: {
                    subtitle_languages: {
                        $cond: {
                            if: { $gt: [{ $size: '$_subs' }, 0] },
                            then: { $map: { input: { $objectToArray: { $arrayElemAt: ['$_subs.subtitles', 0] } }, as: 'l', in: '$$l.k' } },
                            else: []
                        }
                    }
                }
            },
            { $project: { _subs: 0 } },
            ...playlistJoin
        ];

        // Fetch each category in parallel
        await Promise.all(categories.map(async (cat) => {
            const items = await audioCollection.aggregate([
                { $match: { ...baseMatch, ...categoryMatchClause(cat) } },
                { $sort: { createdAt: -1 } },
                { $limit: perGroup },
                ...subtitleJoin
            ]).toArray();
            if (items.length > 0) {
                groups[cat] = items;
            }
        }));

        // Also fetch "popular" (most played) across all categories
        const popular = await audioCollection.aggregate([
            { $match: { ...baseMatch, plays: { $gt: 0 } } },
            { $sort: { plays: -1 } },
            { $limit: perGroup },
            ...subtitleJoin
        ]).toArray();
        if (popular.length > 0) {
            groups.popular = popular;
        }

        // Recent (newest across all)
        const recent = await audioCollection.aggregate([
            { $match: baseMatch },
            { $sort: { createdAt: -1 } },
            { $limit: perGroup },
            ...subtitleJoin
        ]).toArray();
        if (recent.length > 0) {
            groups.recent = recent;
        }

        res.json({ groups });
    } catch (error) {
        console.error('Error fetching grouped audio:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/categories — list distinct categories with counts
router.get('/categories', async (req, res) => {
    try {
        const db = getDb();
        const audioCollection = db.collection('embed-audio');

        const categories = await audioCollection.aggregate([
            { $match: { status: 'published' } },
            { $group: { _id: '$category', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]).toArray();

        res.json({
            categories: categories.map(c => ({ name: c._id || 'uncategorized', count: c.count })),
        });
    } catch (error) {
        console.error('Error fetching audio categories:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/tags — list top tags with counts
router.get('/tags', async (req, res) => {
    try {
        const db = getDb();
        const audioCollection = db.collection('embed-audio');
        const limit = Math.min(parseInt(req.query.limit) || 30, 100);

        const tags = await audioCollection.aggregate([
            { $match: { status: 'published', tags: { $exists: true, $ne: [] } } },
            { $unwind: '$tags' },
            { $group: { _id: '$tags', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: limit },
        ]).toArray();

        res.json({
            tags: tags.map(t => ({ name: t._id, count: t.count })),
        });
    } catch (error) {
        console.error('Error fetching audio tags:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/auto-tags — list top auto-generated tags from subtitles-tags
// (for audio entries that have been processed)
router.get('/auto-tags', async (req, res) => {
    try {
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);

        // Get audio permlinks
        const audioPermlinks = await db.collection('embed-audio')
            .find({ status: 'published' })
            .project({ permlink: 1 })
            .toArray();

        const permlinks = audioPermlinks.map(a => a.permlink);

        // Find matching subtitles-tags
        const tagDocs = await db.collection('subtitles-tags')
            .find({ permlink: { $in: permlinks } })
            .toArray();

        // Parse comma-separated tags and count
        const tagCounts = {};
        for (const doc of tagDocs) {
            const tags = (doc.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            for (const t of tags) {
                tagCounts[t] = (tagCounts[t] || 0) + 1;
            }
        }

        const sorted = Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([name, count]) => ({ name, count }));

        res.json({ tags: sorted, total_tagged: tagDocs.length });
    } catch (error) {
        console.error('Error fetching auto tags:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/creators — list audio creators, optionally filtered
router.get('/creators', async (req, res) => {
    try {
        const db = getDb();
        const audioCollection = db.collection('embed-audio');
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);

        const audioQuery = {
            status: 'published',
            ...nsfwFilter(req),
        };

        // Date filter (days-ago shorthand or ISO)
        if (req.query.from) {
            const days = parseInt(req.query.from);
            if (!isNaN(days) && days > 0) {
                audioQuery.createdAt = { $gte: new Date(Date.now() - days * 86400000) };
            } else {
                audioQuery.createdAt = { $gte: new Date(req.query.from) };
            }
        }

        // Duration filter (seconds)
        const minDur = parseInt(req.query.min_duration);
        const maxDur = parseInt(req.query.max_duration);
        if ((!isNaN(minDur) && minDur > 0) || (!isNaN(maxDur) && maxDur > 0)) {
            audioQuery.duration = {};
            if (!isNaN(minDur) && minDur > 0) audioQuery.duration.$gte = minDur;
            if (!isNaN(maxDur) && maxDur > 0) audioQuery.duration.$lte = maxDur;
        }

        // Auto-tag filter (single or repeated; OR semantics)
        const autoTagFilter = await autoTagPermlinkFilter(db, req.query.auto_tag);
        if (autoTagFilter) audioQuery.permlink = autoTagFilter;

        // Category + genre filters (mirrors /audio)
        applyCategoryFilter(audioQuery, req.query.category);
        if (req.query.genre) {
            const g = String(req.query.genre).trim();
            if (g) {
                const escaped = g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`^${escaped}$`, 'i');
                audioQuery.$and = (audioQuery.$and || []).concat([
                    { $or: [{ genre: regex }, { tags: regex }] },
                ]);
            }
        }

        // Get distinct audio creators with play counts (within the filtered set)
        const creators = await audioCollection.aggregate([
            { $match: audioQuery },
            { $group: {
                _id: '$owner',
                tracks: { $sum: 1 },
                totalPlays: { $sum: { $ifNull: ['$plays', 0] } },
                latestTrack: { $max: '$createdAt' },
            }},
            { $sort: { totalPlays: -1 } },
            { $limit: limit },
        ]).toArray();

        res.json({
            creators: creators.map(c => ({
                owner: c._id,
                tracks: c.tracks,
                totalPlays: c.totalPlays,
                latestTrack: c.latestTrack,
                avatar: `https://images.hive.blog/u/${c._id}/avatar/small`,
            })),
        });
    } catch (error) {
        console.error('Error fetching audio creators:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /audio/:permlink/subtitles — get subtitles for an audio track
router.get('/:permlink/subtitles', async (req, res) => {
    try {
        const db = getDb();
        const { permlink } = req.params;

        const subtitle = await db.collection('subtitles').findOne({ permlink });
        if (!subtitle) {
            return res.json({ found: false, subtitles: null });
        }

        res.json({ found: true, subtitles: subtitle });
    } catch (error) {
        console.error('Error fetching audio subtitles:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
