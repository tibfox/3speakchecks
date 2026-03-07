// View counts cache (5 minute TTL)
const viewsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

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

// Sorted shorts list cache (keyed by "seed|app", 15 minute TTL, max 100 entries)
const sortedShortsCache = new Map();
const SORTED_SHORTS_CACHE_TTL = 15 * 60 * 1000;

module.exports = {
    getCachedViews,
    setCachedViews,
    sortedShortsCache,
    SORTED_SHORTS_CACHE_TTL,
};
