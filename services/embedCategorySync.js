const { getDb } = require('../utils/db');
const { hiveRpcBatch } = require('../utils/hive');
const { ENABLE_MONGO_WRITES } = require('../utils/config');

// A Hive post's community is its `category` (parent_permlink). The external embed
// indexer stores hive_author/permlink/title/body/tags on each embed-video doc but
// NOT the category, so community feeds (which filter on community) silently drop
// every embed video whose posting client didn't also list the community id in its
// json_metadata tags (~85% of them). This sync resolves the real category via
// get_content and persists it so /feeds/community/* can filter reliably.
//
// Scope: recent docs only (WINDOW_DAYS) and only those still missing `category`,
// so each run is cheap and new uploads get picked up on the next pass.

const WINDOW_DAYS = parseInt(process.env.EMBED_CATEGORY_WINDOW_DAYS || '90', 10);
const RPC_BATCH = 20;

async function syncEmbedCategories() {
    const db = getDb();
    const ev = db.collection('embed-video');
    const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const docs = await ev.find({
        status: 'published',
        hive_author: { $ne: null },
        hive_permlink: { $ne: null },
        category: { $exists: false },
        createdAt: { $gte: windowStart },
    }).project({ hive_author: 1, hive_permlink: 1 }).toArray();

    if (docs.length === 0) {
        console.log('[embedCategorySync] no embed videos missing category in the last ' + WINDOW_DAYS + 'd');
        return { scanned: 0, updated: 0 };
    }
    console.log(`[embedCategorySync] resolving category for ${docs.length} embed videos`);

    let updated = 0;
    for (let i = 0; i < docs.length; i += RPC_BATCH) {
        const slice = docs.slice(i, i + RPC_BATCH);
        const rpcBatch = slice.map((d, idx) => ({
            jsonrpc: '2.0',
            id: idx,
            method: 'condenser_api.get_content',
            params: [d.hive_author, d.hive_permlink],
        }));

        const results = await hiveRpcBatch(rpcBatch);
        const ops = [];
        for (const r of results) {
            const post = r && r.result;
            if (!post || !post.author) continue;
            const category = post.category || null;
            if (!category) continue; // missing/deleted post — retry next run
            ops.push({
                updateOne: {
                    filter: { hive_author: post.author, hive_permlink: post.permlink },
                    update: { $set: { category } },
                },
            });
        }

        if (ops.length && ENABLE_MONGO_WRITES) {
            try {
                const res = await ev.bulkWrite(ops, { ordered: false });
                updated += res.modifiedCount || 0;
            } catch (err) {
                console.error('[embedCategorySync] bulkWrite error:', err.message);
            }
        }
    }

    console.log(`[embedCategorySync] updated category on ${updated}/${docs.length} embed videos`);
    return { scanned: docs.length, updated };
}

module.exports = { syncEmbedCategories };
