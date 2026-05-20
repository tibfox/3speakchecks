const { HIVE_RPC_ENDPOINTS } = require('./config');

// Caches
const rewardCache = new Map();
const REWARD_CACHE_TTL = 15 * 60 * 1000;

const reputationCache = new Map();
const REPUTATION_CACHE_TTL = 8 * 60 * 60 * 1000;

const followerCache = new Map();
const FOLLOWER_CACHE_TTL = 4 * 60 * 60 * 1000;

const followingCache = new Map();
const FOLLOWING_CACHE_TTL = 10 * 60 * 1000;

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
    return [];
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
async function fetchHiveRewards(authorPerms) {
    const results = new Map();
    const toFetch = [];

    for (const { author, permlink } of authorPerms) {
        const key = `${author}/${permlink}`;
        const cached = rewardCache.get(key);
        if (cached && Date.now() - cached.timestamp < REWARD_CACHE_TTL) {
            results.set(key, { reward: cached.reward, title: cached.title || '', body: cached.body || '', tags: cached.tags || [] });
        } else {
            toFetch.push({ author, permlink, key });
        }
    }

    // Build all batches up front, then fire them in parallel — was sequential
    // (await inside the for-loop), which made the cold-cache trending feed
    // O(N/20) Hive roundtrips instead of one wall-clock roundtrip.
    const batches = [];
    for (let i = 0; i < toFetch.length; i += 20) {
        batches.push({ offset: i, items: toFetch.slice(i, i + 20) });
    }
    await Promise.all(batches.map(async ({ offset, items }) => {
        const rpcBatch = items.map((item, idx) => ({
            jsonrpc: '2.0',
            id: offset + idx,
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
            let tags = [];
            try {
                const metadata = JSON.parse(post.json_metadata || '{}');
                tags = Array.isArray(metadata.tags) ? metadata.tags : [];
            } catch (e) { /* ignore */ }

            results.set(postKey, { reward, title, body, tags });
            rewardCache.set(postKey, { reward, title, body, tags, timestamp: Date.now() });

            if (!reputationCache.has(post.author) || Date.now() - (reputationCache.get(post.author)?.timestamp || 0) >= REPUTATION_CACHE_TTL) {
                reputationCache.set(post.author, { reputation: hiveReputationToScore(post.author_reputation), timestamp: Date.now() });
            }
        }

        for (const item of items) {
            if (!results.has(item.key)) {
                results.set(item.key, { reward: 0, title: '', body: '', tags: [] });
            }
        }
    }));

    return results;
}

// Fetch live display data for the current page (no cache for post-level data)
async function fetchLivePageData(authorPerms) {
    const results = new Map();

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

// Fetch follower counts via RPC in batches of 20
async function fetchFollowerCounts(authors) {
    const results = new Map();
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

// Fetch following list from Hive RPC API
async function getFollowingList(username) {
    const cached = followingCache.get(username);
    if (cached && Date.now() - cached.timestamp < FOLLOWING_CACHE_TTL) {
        return cached.following;
    }

    try {
        const following = [];
        let startFollowing = '';
        const batchSize = 1000;

        while (true) {
            const result = await hiveRpcBatch([{
                jsonrpc: '2.0',
                id: 1,
                method: 'condenser_api.get_following',
                params: [username, startFollowing, 'blog', batchSize]
            }]);

            if (!result || result.length === 0 || !result[0].result) break;

            const batch = result[0].result;
            if (batch.length === 0) break;

            for (const entry of batch) {
                if (entry.following === startFollowing) continue;
                following.push(entry.following);
            }

            if (batch.length < batchSize) break;
            startFollowing = batch[batch.length - 1].following;
        }

        if (following.length === 0) {
            console.log(`User ${username} follows nobody or following list is empty`);
            return null;
        }

        followingCache.set(username, { following, timestamp: Date.now() });
        return following;

    } catch (error) {
        console.error(`Error fetching following list for ${username}:`, error.message);
        return null;
    }
}

// Seeded PRNG (mulberry32)
function mulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

module.exports = {
    hiveRpcBatch,
    hiveReputationToScore,
    fetchHiveRewards,
    fetchLivePageData,
    fetchFollowerCounts,
    getFollowingList,
    mulberry32,
    reputationCache,
    REPUTATION_CACHE_TTL,
};
