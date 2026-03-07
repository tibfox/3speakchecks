const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { nsfwFilter, nsfwFilterTags, nsfwFilterHiveTags } = require('../utils/filters');

router.get('/', async (req, res) => {
    try {
        const db = getDb();
        const q = (req.query.q || '').trim();
        if (!q) {
            return res.status(400).json({ success: false, error: 'Query parameter "q" is required' });
        }

        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const type = req.query.type || 'all';

        const textQuery = { $text: { $search: q } };
        const scoreProj = { score: { $meta: 'textScore' } };
        const scoreSort = { score: { $meta: 'textScore' } };

        const searches = [];

        // Videos (non-embed, legacy)
        if (type === 'all' || type === 'video') {
            searches.push(
                db.collection('videos').find({
                    ...textQuery,
                    status: 'published',
                    publishFailed: { $ne: true },
                    ...nsfwFilterTags(req)
                }, { projection: scoreProj })
                .sort(scoreSort).limit(200).toArray()
                .then(docs => docs.map(d => ({
                    type: 'video',
                    owner: d.owner,
                    author: d.author || d.owner,
                    permlink: d.permlink,
                    title: d.title || '',
                    body: d.description || d.body || '',
                    created_at: d.created || d.created_at || d.createdAt,
                    duration: d.duration || 0,
                    tags: d.tags_v2 || d.tags || [],
                    images: {
                        thumbnail: d.thumbnail || d.images?.thumbnail || `https://img.3speak.tv/${d.permlink}/thumbnail.png`,
                        poster: d.images?.poster || `https://img.3speak.tv/${d.permlink}/poster.jpg`
                    },
                    views: d.views || 0,
                    score: d.score
                })))
            );
        }

        // Embed videos (non-shorts)
        if (type === 'all' || type === 'video') {
            searches.push(
                db.collection('embed-video').find({
                    ...textQuery,
                    status: 'published',
                    short: false,
                    listed_on_3speak: true,
                    hive_author: { $ne: null },
                    hive_permlink: { $ne: null },
                    ...nsfwFilterHiveTags(req)
                }, { projection: scoreProj })
                .sort(scoreSort).limit(200).toArray()
                .then(docs => docs.map(d => ({
                    type: 'video',
                    owner: d.owner,
                    author: d.hive_author || d.owner,
                    permlink: d.hive_permlink || d.permlink,
                    title: d.hive_title || d.originalFilename || '',
                    body: d.hive_body || '',
                    created_at: d.createdAt,
                    duration: d.duration || 0,
                    tags: d.hive_tags || [],
                    images: {
                        thumbnail: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/thumbnail.png`,
                        poster: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/poster.jpg`
                    },
                    views: d.views || 0,
                    score: d.score
                })))
            );
        }

        // Shorts (embed-video with short: true)
        if (type === 'all' || type === 'short') {
            searches.push(
                db.collection('embed-video').find({
                    ...textQuery,
                    status: 'published',
                    short: true,
                    processed: true,
                    embed_url: { $exists: true, $ne: null },
                    ...nsfwFilterHiveTags(req)
                }, { projection: scoreProj })
                .sort(scoreSort).limit(200).toArray()
                .then(docs => docs.map(d => ({
                    type: 'short',
                    owner: d.owner,
                    author: d.hive_author || d.owner,
                    permlink: d.permlink,
                    title: d.hive_title || d.embed_title || d.originalFilename || '',
                    body: d.hive_body || '',
                    created_at: d.createdAt,
                    duration: d.duration || 0,
                    tags: d.hive_tags || [],
                    images: {
                        thumbnail: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/thumbnail.png`,
                        poster: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/poster.jpg`
                    },
                    embed_url: d.embed_url,
                    views: d.views || 0,
                    score: d.score
                })))
            );
        }

        // Audio
        if (type === 'all' || type === 'audio') {
            searches.push(
                db.collection('embed-audio').find({
                    ...textQuery,
                    ...nsfwFilter(req)
                }, { projection: scoreProj })
                .sort(scoreSort).limit(200).toArray()
                .then(docs => docs.map(d => ({
                    type: 'audio',
                    owner: d.owner,
                    permlink: d.permlink,
                    title: d.title || d.originalFilename || '',
                    body: d.description || '',
                    created_at: d.createdAt,
                    duration: d.duration || 0,
                    tags: d.tags ? (Array.isArray(d.tags) ? d.tags : d.tags.split(',').map(t => t.trim())) : [],
                    score: d.score
                })))
            );
        }

        // Communities
        if (type === 'all' || type === 'community') {
            searches.push(
                db.collection('hivecommunities').find(
                    textQuery,
                    { projection: scoreProj }
                )
                .sort(scoreSort).limit(50).toArray()
                .then(docs => docs.map(d => ({
                    type: 'community',
                    name: d.name,
                    title: d.title || '',
                    about: d.about || '',
                    description: d.description || '',
                    subscribers: d.subscribers || 0,
                    num_authors: d.num_authors || 0,
                    score: d.score
                })))
            );
        }

        // Subtitle-tags join: find videos matching by AI-generated tags
        if (type === 'all' || type === 'video' || type === 'short') {
            const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            searches.push(
                db.collection('subtitles-tags').find({
                    tags: { $regex: escapedQ, $options: 'i' }
                }).limit(100).toArray()
                .then(async (tagDocs) => {
                    if (tagDocs.length === 0) return [];

                    const lookups = tagDocs.map(t => ({ owner: t.author, permlink: t.permlink }));

                    const [vids, embeds] = await Promise.all([
                        db.collection('videos').find({
                            $or: lookups,
                            status: 'published',
                            publishFailed: { $ne: true },
                            ...nsfwFilterTags(req)
                        }).limit(50).toArray(),
                        db.collection('embed-video').find({
                            $or: lookups.map(l => ({ owner: l.owner, permlink: l.permlink })),
                            status: 'published',
                            ...nsfwFilterHiveTags(req)
                        }).limit(50).toArray()
                    ]);

                    const results = [];
                    for (const d of vids) {
                        results.push({
                            type: 'video',
                            owner: d.owner,
                            author: d.author || d.owner,
                            permlink: d.permlink,
                            title: d.title || '',
                            body: d.description || d.body || '',
                            created_at: d.created || d.created_at || d.createdAt,
                            duration: d.duration || 0,
                            tags: d.tags_v2 || d.tags || [],
                            images: {
                                thumbnail: d.thumbnail || d.images?.thumbnail || `https://img.3speak.tv/${d.permlink}/thumbnail.png`,
                                poster: d.images?.poster || `https://img.3speak.tv/${d.permlink}/poster.jpg`
                            },
                            views: d.views || 0,
                            score: 0.5
                        });
                    }
                    for (const d of embeds) {
                        results.push({
                            type: d.short ? 'short' : 'video',
                            owner: d.owner,
                            author: d.hive_author || d.owner,
                            permlink: d.short ? d.permlink : (d.hive_permlink || d.permlink),
                            title: d.hive_title || d.embed_title || d.originalFilename || '',
                            body: d.hive_body || '',
                            created_at: d.createdAt,
                            duration: d.duration || 0,
                            tags: d.hive_tags || [],
                            images: {
                                thumbnail: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/thumbnail.png`,
                                poster: d.thumbnail_url || `https://img.3speak.tv/${d.permlink}/poster.jpg`
                            },
                            views: d.views || 0,
                            score: 0.5
                        });
                    }
                    return results;
                })
            );
        }

        // Execute all searches in parallel
        const allResults = (await Promise.all(searches)).flat();

        // Deduplicate by owner+permlink+type (text search results take priority)
        const seen = new Set();
        const deduped = [];
        allResults.sort((a, b) => b.score - a.score);
        for (const r of allResults) {
            const key = `${r.type}:${r.owner}:${r.permlink}`;
            if (!seen.has(key)) {
                seen.add(key);
                deduped.push(r);
            }
        }

        const total = deduped.length;
        const totalPages = Math.ceil(total / limit);
        const skip = (page - 1) * limit;
        const paged = deduped.slice(skip, skip + limit);

        res.json({
            success: true,
            query: q,
            page,
            limit,
            total,
            totalPages,
            results: paged
        });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ success: false, error: 'Search failed' });
    }
});

module.exports = router;
