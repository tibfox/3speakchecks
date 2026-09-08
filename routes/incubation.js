// Read side for INCUBATING users — people using 3Speak who have no Hive account
// yet. Their content is off-chain, in the incubation_* collections written by
// the separate incubation service (prodops/services/incubation).
//
// Reads live HERE and writes live THERE, deliberately. Feeds, profiles and
// thread merges are this service's job and it already has the indexes, the
// caching and the frontend pointed at it; accepting user comments into 3Speak's
// database is not, and the incubation service owns that lifecycle (including
// the graduation replay, which has to stay next to the code that knows which
// operation types can be replayed at all).
//
// TWO RULES that every handler here follows:
//
//  1. Resolve the handle to a userId FIRST, then query by userId. The `handle`
//     field denormalised onto each content row is a RENDER CACHE: a user can
//     change their handle while incubating, and again at graduation if the name
//     got taken on Hive meanwhile. Querying by it returns a stale slice.
//
//  2. Never return rows that have already been published to Hive. Once a
//     graduating user's post is replayed on chain, the Hive-backed feed is its
//     home; returning it here too would double it in every list.

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');

const ACCOUNTS = 'incubation_accounts';
const COMMENTS = 'incubation_comments';
const PROFILES = 'incubation_profiles';
const FOLLOWS = 'incubation_follows';

const clampLimit = (v, def, max) => Math.min(Math.max(parseInt(v, 10) || def, 1), max);

/**
 * handle -> { userId, handle, status, hiveUsername } for a batch of handles.
 *
 * Reads incubation_accounts, the mirror the incubation service maintains, NOT
 * butrauth's own users collection. Both live in this database, so reading
 * butrauth directly would work and would be a mistake: that schema is another
 * service's private business and nothing here would notice it changing.
 */
async function resolveHandles(db, handles) {
    const wanted = [...new Set(handles.filter(h => typeof h === 'string' && h).map(h => h.toLowerCase()))];
    if (!wanted.length) return {};
    const rows = await db.collection(ACCOUNTS)
        .find({ handle: { $in: wanted } })
        .project({ butrauthUserId: 1, handle: 1, status: 1, hiveUsername: 1 })
        .toArray();
    const out = {};
    for (const r of rows) {
        out[r.handle] = {
            userId: r.butrauthUserId,
            handle: r.handle,
            status: r.status || 'incubating',
            hiveUsername: r.hiveUsername || null,
        };
    }
    return out;
}

function shapePost(r) {
    return {
        permlink: r.permlink,
        title: r.title || '',
        body: r.body || '',
        handle: r.handle,
        videoId: r.videoId || null,
        parentAuthor: r.parentAuthor || '',
        parentPermlink: r.parentPermlink || '',
        jsonMetadata: r.jsonMetadata || {},
        created: r.createdAt,
        // No Hive author exists yet. Saying so explicitly stops a frontend from
        // building an @author link that would 404 on every other Hive site.
        onChain: false,
    };
}

// POST /incubation/authors  { handles: [...] }
// Batch handle -> identity, so a feed can render author names in one call
// instead of one per card.
router.post('/authors', async (req, res) => {
    try {
        const { handles } = req.body || {};
        if (!Array.isArray(handles)) return res.status(400).json({ error: 'handles must be an array' });
        if (handles.length > 100) return res.status(400).json({ error: 'At most 100 handles per request' });
        const db = getDb();
        res.set('Cache-Control', 'public, max-age=30');
        res.json({ authors: await resolveHandles(db, handles) });
    } catch (err) {
        console.error('[incubation] authors:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /incubation/profile/:handle — profile, interests and counts.
router.get('/profile/:handle', async (req, res) => {
    try {
        const db = getDb();
        const handle = String(req.params.handle || '').toLowerCase();
        const who = (await resolveHandles(db, [handle]))[handle];
        if (!who) return res.status(404).json({ error: 'No such user' });

        const [profileRow, postCount, followingCount] = await Promise.all([
            db.collection(PROFILES).findOne({ butrauthUserId: who.userId }),
            db.collection(COMMENTS).countDocuments({ butrauthUserId: who.userId, kind: 'post' }),
            db.collection(FOLLOWS).countDocuments({ butrauthUserId: who.userId, state: 'following' }),
        ]);

        const profile = profileRow?.profile || {};
        res.json({
            handle: who.handle,
            status: who.status,
            hiveUsername: who.hiveUsername,
            profile: {
                name: profile.name || null,
                about: profile.about || null,
                location: profile.location || null,
                website: profile.website || null,
                profile_image: profile.profile_image || null,
                cover_image: profile.cover_image || null,
            },
            interests: Array.isArray(profile.interests) ? profile.interests : [],
            counts: {
                posts: postCount,
                following: followingCount,
                // Followers are NOT counted: nobody can follow an incubating
                // user yet (there is no account to follow), and returning 0
                // would read as "has no followers" rather than "not applicable".
                followers: null,
            },
        });
    } catch (err) {
        console.error('[incubation] profile:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /incubation/user/:handle/posts — one user's posts, newest first.
router.get('/user/:handle/posts', async (req, res) => {
    try {
        const db = getDb();
        const handle = String(req.params.handle || '').toLowerCase();
        const who = (await resolveHandles(db, [handle]))[handle];
        if (!who) return res.status(404).json({ error: 'No such user' });

        const limit = clampLimit(req.query.limit, 30, 100);
        const rows = await db.collection(COMMENTS)
            .find({ butrauthUserId: who.userId, kind: 'post', publishedAt: null })
            .sort({ createdAt: -1 }).limit(limit).toArray();
        res.json({ author: who, items: rows.map(shapePost) });
    } catch (err) {
        console.error('[incubation] user posts:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /incubation/feed — recent off-chain posts, for interleaving into the home
// and discover feeds next to the Hive-backed ones.
//
// Authors are resolved and attached in ONE batch rather than per row: this is
// the hot path and a lookup per card is what turns a feed into N+1 queries.
router.get('/feed', async (req, res) => {
    try {
        const db = getDb();
        const limit = clampLimit(req.query.limit, 20, 50);
        const maxAgeDays = Math.min(parseFloat(req.query.maxAgeDays) || 30, 90);
        const since = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

        const rows = await db.collection(COMMENTS)
            .find({ kind: 'post', publishedAt: null, createdAt: { $gte: since } })
            .sort({ createdAt: -1 }).limit(limit).toArray();

        const authors = await resolveHandles(db, rows.map(r => r.handle));
        res.set('Cache-Control', 'public, max-age=30');
        res.json({
            items: rows.map(r => ({
                ...shapePost(r),
                // Re-resolved rather than trusting the denormalised handle, so a
                // renamed author renders correctly. A row whose author has since
                // been erased resolves to null and the frontend can skip it.
                author: authors[r.handle] || null,
            })),
        });
    } catch (err) {
        console.error('[incubation] feed:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// GET /incubation/replies?parentAuthor=&parentPermlink=
//
// The off-chain replies under a piece of content, so a watch page can merge
// them into the Hive comment thread it already fetches. Incubating users are
// commenting on REAL Hive posts, so without this their comments are invisible
// on the very page they were written for.
router.get('/replies', async (req, res) => {
    try {
        const { parentAuthor, parentPermlink } = req.query;
        if (typeof parentAuthor !== 'string' || typeof parentPermlink !== 'string') {
            return res.status(400).json({ error: 'parentAuthor and parentPermlink are required' });
        }
        const db = getDb();
        const limit = clampLimit(req.query.limit, 100, 200);
        const rows = await db.collection(COMMENTS)
            .find({ parentAuthor, parentPermlink, publishedAt: null })
            .sort({ createdAt: -1 }).limit(limit).toArray();

        const authors = await resolveHandles(db, rows.map(r => r.handle));
        res.json({
            items: rows.map(r => ({ ...shapePost(r), author: authors[r.handle] || null })),
        });
    } catch (err) {
        console.error('[incubation] replies:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

module.exports = router;
