/**
 * Tests for NSFW/banned filter application on embed-video queries.
 *
 * Verifies that all embed-video queries in routes/videos.js include
 * nsfwFilterHiveTags (banned + hive_tags NSFW exclusion) and that
 * /videodetails applies BANNED_FILTER.
 */

const express = require('express');
const request = require('supertest');

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockCursor(docs = []) {
    return {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        batchSize: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(docs),
    };
}

function mockCollection() {
    return {
        find: jest.fn().mockReturnValue(mockCursor([])),
        findOne: jest.fn().mockResolvedValue(null),
        countDocuments: jest.fn().mockResolvedValue(0),
    };
}

const mockVideosCol = mockCollection();
const mockEmbedCol = mockCollection();

// Mock dependencies before requiring the router
jest.mock('../utils/db', () => ({
    getDb: () => ({
        collection: (name) => {
            if (name === 'videos') return mockVideosCol;
            if (name === 'embed-video') return mockEmbedCol;
            return mockCollection();
        },
    }),
}));

jest.mock('../utils/hive', () => ({
    getFollowingList: jest.fn().mockResolvedValue([]),
}));

jest.mock('../utils/cache', () => ({
    getCachedViews: jest.fn().mockReturnValue(null),
    setCachedViews: jest.fn(),
    sortedShortsCache: new Map(),
    SORTED_SHORTS_CACHE_TTL: 0,
}));

jest.mock('../utils/middleware', () => ({
    validateApiKey: (req, res, next) => next(),
}));

jest.mock('../utils/config', () => ({
    ENABLE_MONGO_WRITES: false,
    HIDDEN_AUTHORS: ['threespeak-fixer'],
    API_SECRET_KEY: 'test',
    HIVE_RPC_ENDPOINTS: ['https://api.hive.blog'],
}));

const router = require('../routes/videos');

// Build a minimal express app for supertest
const app = express();
app.use(express.json());
app.use(router);

// ---------------------------------------------------------------------------
// Expected filter shapes
// ---------------------------------------------------------------------------

const BANNED_ONLY = { banned: { $ne: true } };

const NSFW_HIVE_TAGS_FILTER = {
    banned: { $ne: true },
    hive_tags: { $nin: ['nsfw', 'NSFW'] },
    isNsfwContent: { $ne: true },
};

// When the regex fallback path is used (useLower=false), buildEmbedFilter
// combines the NSFW hive_tags filter and the tag match via $and to avoid
// key collision on the hive_tags field.
function expectEmbedFilterApplied(query) {
    // Must have banned + isNsfwContent from nsfwFilterHiveTags
    expect(query.banned).toEqual({ $ne: true });
    expect(query.isNsfwContent).toEqual({ $ne: true });
    // hive_tags NSFW exclusion and tag match combined in $and
    expect(query.$and).toBeDefined();
    expect(query.$and).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ hive_tags: { $nin: ['nsfw', 'NSFW'] } }),
        ])
    );
}

function expectEmbedFilterRelaxed(query) {
    // With nsfw=true, only banned filter — no hive_tags restriction, no $and needed
    expect(query.banned).toEqual({ $ne: true });
    expect(query.$and).toBeUndefined();
    expect(query.isNsfwContent).toBeUndefined();
}

const NSFW_LEGACY_FILTER = {
    banned: { $ne: true },
    isNsfwContent: { $ne: true },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
    for (const col of [mockVideosCol, mockEmbedCol]) {
        col.find.mockReset().mockReturnValue(mockCursor([]));
        col.findOne.mockReset().mockResolvedValue(null);
        col.countDocuments.mockReset().mockResolvedValue(0);
    }
}

// ---------------------------------------------------------------------------
// Section A — Pure unit tests for utils/filters.js
// ---------------------------------------------------------------------------

describe('utils/filters', () => {
    const { BANNED_FILTER, nsfwFilter, nsfwFilterTags, nsfwFilterHiveTags } = require('../utils/filters');

    test('BANNED_FILTER shape', () => {
        expect(BANNED_FILTER).toEqual({ banned: { $ne: true } });
    });

    test('nsfwFilter — nsfw disallowed', () => {
        const req = { query: {} };
        expect(nsfwFilter(req)).toEqual({
            banned: { $ne: true },
            isNsfwContent: { $ne: true },
        });
    });

    test('nsfwFilter — nsfw allowed', () => {
        const req = { query: { nsfw: 'true' } };
        expect(nsfwFilter(req)).toEqual({ banned: { $ne: true } });
    });

    test('nsfwFilterTags — nsfw disallowed', () => {
        const req = { query: {} };
        expect(nsfwFilterTags(req)).toEqual({
            banned: { $ne: true },
            tags_v2: { $nin: ['nsfw'] },
            isNsfwContent: { $ne: true },
        });
    });

    test('nsfwFilterHiveTags — nsfw disallowed', () => {
        const req = { query: {} };
        expect(nsfwFilterHiveTags(req)).toEqual(NSFW_HIVE_TAGS_FILTER);
    });

    test('nsfwFilterHiveTags — nsfw allowed', () => {
        const req = { query: { nsfw: 'true' } };
        expect(nsfwFilterHiveTags(req)).toEqual({ banned: { $ne: true } });
    });
});

// ---------------------------------------------------------------------------
// Section B — Route-level tests: verify filters reach the DB queries
// ---------------------------------------------------------------------------

describe('GET /videos/tag/:tag', () => {
    beforeEach(resetMocks);

    test('type=shorts — embed query includes nsfwFilterHiveTags', async () => {
        await request(app).get('/videos/tag/gaming?type=shorts');

        const findCall = mockEmbedCol.find.mock.calls[0];
        expect(findCall).toBeDefined();

        const query = findCall[0];
        expectEmbedFilterApplied(query);
        expect(query.short).toBe(true);
    });

    test('type=shorts with nsfw=true — filter relaxed to banned-only', async () => {
        await request(app).get('/videos/tag/gaming?type=shorts&nsfw=true');

        const query = mockEmbedCol.find.mock.calls[0][0];
        expectEmbedFilterRelaxed(query);
    });

    test('type=videos — embed query includes nsfwFilterHiveTags', async () => {
        await request(app).get('/videos/tag/gaming?type=videos');

        const embedQuery = mockEmbedCol.find.mock.calls[0][0];
        expectEmbedFilterApplied(embedQuery);

        // legacy .find should use nsfwFilter (no hive_tags field)
        const legacyQuery = mockVideosCol.find.mock.calls[0][0];
        expect(legacyQuery).toMatchObject(NSFW_LEGACY_FILTER);
    });

    test('no type — embed query includes nsfwFilterHiveTags', async () => {
        await request(app).get('/videos/tag/gaming');

        const embedQuery = mockEmbedCol.find.mock.calls[0][0];
        expectEmbedFilterApplied(embedQuery);

        const legacyQuery = mockVideosCol.find.mock.calls[0][0];
        expect(legacyQuery).toMatchObject(NSFW_LEGACY_FILTER);
    });

    test('mantecurated — embed query includes nsfwFilterHiveTags', async () => {
        await request(app).get('/videos/tag/mantecurated');

        // For mantecurated, embed-video is queried via .find (fetchEmbed)
        const embedQuery = mockEmbedCol.find.mock.calls[0][0];
        expect(embedQuery).toMatchObject(NSFW_HIVE_TAGS_FILTER);
        expect(embedQuery.mantecurated).toBe(true);

        // Legacy uses nsfwFilter
        const legacyQuery = mockVideosCol.find.mock.calls[0][0];
        expect(legacyQuery).toMatchObject(NSFW_LEGACY_FILTER);
    });
});

describe('GET /videos/tag/:tag/counts', () => {
    beforeEach(resetMocks);

    test('regular tag — all three count queries are filtered', async () => {
        await request(app).get('/videos/tag/gaming/counts');

        // countDocuments is called 2 times on embed (videos + shorts) and 1 on legacy
        const embedCalls = mockEmbedCol.countDocuments.mock.calls;
        expect(embedCalls.length).toBe(2);

        // Both embed count queries should include nsfwFilterHiveTags via buildEmbedFilter
        for (const [query] of embedCalls) {
            expectEmbedFilterApplied(query);
        }

        // Legacy count
        const legacyQuery = mockVideosCol.countDocuments.mock.calls[0][0];
        expect(legacyQuery).toMatchObject(NSFW_LEGACY_FILTER);
    });

    test('mantecurated counts — embed query filtered', async () => {
        await request(app).get('/videos/tag/mantecurated/counts');

        const embedQuery = mockEmbedCol.countDocuments.mock.calls[0][0];
        expect(embedQuery).toMatchObject(NSFW_HIVE_TAGS_FILTER);
    });
});

describe('GET /videodetails/:author/:permlink', () => {
    beforeEach(resetMocks);

    test('applies BANNED_FILTER to videos collection', async () => {
        mockVideosCol.findOne.mockResolvedValue({ owner: 'alice', permlink: 'test', mantecurated: false });

        await request(app).get('/videodetails/alice/test');

        const query = mockVideosCol.findOne.mock.calls[0][0];
        expect(query).toMatchObject(BANNED_ONLY);
        expect(query.owner).toBe('alice');
        expect(query.permlink).toBe('test');
    });

    test('falls through to embed-video with BANNED_FILTER', async () => {
        mockVideosCol.findOne.mockResolvedValue(null);
        mockEmbedCol.findOne.mockResolvedValue({ owner: 'bob', permlink: 'snap1' });

        await request(app).get('/videodetails/bob/snap1');

        const embedQuery = mockEmbedCol.findOne.mock.calls[0][0];
        expect(embedQuery).toMatchObject(BANNED_ONLY);
        expect(embedQuery.owner).toBe('bob');
    });

    test('returns 404 for banned video (both collections return null)', async () => {
        const res = await request(app).get('/videodetails/alice/banned-vid');
        expect(res.status).toBe(404);
    });
});
