/**
 * Audio–Hive Link Sync
 *
 * Finds embed-audio entries with no post_permlink and searches the owner's
 * recent Hive posts for a body that references the audio permlink
 * (pattern: audio.3speak.tv/play?a=<permlink> or embed containing the permlink).
 *
 * When a match is found, updates the embed-audio document with:
 *   - post_permlink: the Hive permlink
 *   - post_author:   the Hive author (usually same as owner)
 *
 * Designed to be called on a schedule (e.g. every 30 minutes).
 * Only processes a batch per run to avoid hammering the Hive API.
 */

const { getDb } = require('../utils/db');
const { ENABLE_MONGO_WRITES, HIVE_RPC_ENDPOINTS, PPL_BENEFICIARY } = require('../utils/config');

// A track is "pay-per-listen" when its Hive post assigns (almost) all
// beneficiary weight to PPL_BENEFICIARY (uploader sets 10000 = 100%). We
// accept ≥9000 to tolerate any small app/platform cut added later.
const PPL_MIN_WEIGHT = 9000;

const BATCH_SIZE = 30;
const HIVE_POSTS_PER_USER = 20;

// Rotate through RPC endpoints
let rpcIdx = 0;
function getEndpoint() {
    const ep = HIVE_RPC_ENDPOINTS[rpcIdx % HIVE_RPC_ENDPOINTS.length];
    rpcIdx++;
    return ep;
}

async function hiveRpc(method, params) {
    const endpoint = getEndpoint();
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
    const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });
    const data = await resp.json();
    if (data.error) {
        console.error(`[audioHiveSync] RPC error from ${endpoint}: ${data.error.message}`, body.substring(0, 200));
        throw new Error(data.error.message || 'RPC error');
    }
    return data.result;
}

// Bitmask for filtering account_history to only comment_operation (op id 1).
// hivemind's bridge.get_account_posts does NOT surface peak.snaps replies
// (they're filtered as snap noise), so we have to walk raw ops.
const COMMENT_OP_FILTER_LOW = 2; // 1 << 1

async function getRecentPosts(account, limit = HIVE_POSTS_PER_USER) {
    // Walk the account's recent comment operations directly. This catches
    // snap-style audio replies under peak.snaps that hivemind hides from
    // bridge.get_account_posts. Returns {author, permlink, body, json_metadata}
    // shaped like a hivemind post so the caller doesn't change.
    const ops = await hiveRpc('condenser_api.get_account_history', [
        account,
        -1,
        Math.max(limit, 50),
        COMMENT_OP_FILTER_LOW,
        0,
    ]).catch(() => []);

    if (!Array.isArray(ops)) return [];

    const posts = [];
    const seen = new Set();
    for (const entry of ops) {
        const op = entry?.[1]?.op;
        if (!op || op[0] !== 'comment') continue;
        const c = op[1];
        // Only the user's own comments — skip anything authored by someone else
        if (c.author !== account) continue;
        const key = `${c.author}/${c.permlink}`;
        if (seen.has(key)) continue;
        seen.add(key);
        posts.push({
            author: c.author,
            permlink: c.permlink,
            parent_author: c.parent_author,
            parent_permlink: c.parent_permlink,
            body: c.body,
            json_metadata: c.json_metadata,
        });
    }
    return posts;
}

// Is (author/permlink)'s Hive post a pay-per-listen post? Reads the stored
// beneficiaries via get_content (persists well past payout). Returns
// true/false, or null if we couldn't determine it (don't poison the flag).
async function isPplPost(author, permlink) {
    try {
        const c = await hiveRpc('condenser_api.get_content', [author, permlink]);
        if (!c || !Array.isArray(c.beneficiaries)) return false;
        const total = c.beneficiaries
            .filter(b => b && b.account === PPL_BENEFICIARY)
            .reduce((sum, b) => sum + (Number(b.weight) || 0), 0);
        return total >= PPL_MIN_WEIGHT;
    } catch {
        return null;
    }
}

/**
 * Run one batch of audio→Hive link resolution.
 * @returns {{ checked: number, linked: number, errors: number }}
 */
async function syncAudioHiveLinks() {
    const db = getDb();
    const audioCol = db.collection('embed-audio');

    // Find audio entries missing a Hive link (skip already-checked ones)
    const unlinked = await audioCol.find({
        status: 'published',
        hive_link_checked: { $ne: true },
        $or: [
            { post_permlink: null },
            { post_permlink: { $exists: false } },
        ],
    })
        .sort({ createdAt: -1 })
        .limit(BATCH_SIZE)
        .toArray();

    if (unlinked.length === 0) {
        console.log('[audioHiveSync] No unlinked audio entries found.');
        return { checked: 0, linked: 0, errors: 0 };
    }

    console.log(`[audioHiveSync] Processing ${unlinked.length} unlinked audio entries…`);

    // Group by owner to avoid duplicate Hive API calls
    const byOwner = {};
    for (const audio of unlinked) {
        if (!byOwner[audio.owner]) byOwner[audio.owner] = [];
        byOwner[audio.owner].push(audio);
    }

    let linked = 0;
    let errors = 0;

    for (const [owner, items] of Object.entries(byOwner)) {
        try {
            const posts = await getRecentPosts(owner);
            if (!Array.isArray(posts)) continue;

            for (const audio of items) {
                // Search for the audio permlink in post bodies
                const match = posts.find(p =>
                    p.body && (
                        p.body.includes(audio.permlink) ||
                        p.body.includes(`play?a=${audio.permlink}`) ||
                        p.body.includes(`audio_cid=${audio.audio_cid}`)
                    )
                );

                if (match) {
                    // Pull through any audio metadata the uploader put in json_metadata.audio
                    // (type, genre, bpm) so the API can filter on them.
                    const $set = {
                        post_permlink: match.permlink,
                        post_author: match.author,
                    };
                    try {
                        const meta = typeof match.json_metadata === 'string'
                            ? JSON.parse(match.json_metadata)
                            : (match.json_metadata || {});
                        const audioMeta = meta?.audio;
                        if (audioMeta && typeof audioMeta === 'object') {
                            if (typeof audioMeta.type === 'string') $set.category = audioMeta.type;
                            if (typeof audioMeta.genre === 'string') $set.genre = audioMeta.genre;
                            const bpmNum = parseInt(audioMeta.bpm, 10);
                            if (!isNaN(bpmNum) && bpmNum > 0) $set.bpm = bpmNum;
                        }
                    } catch { /* ignore parse errors */ }

                    // Flag pay-per-listen posts so the player only opens
                    // listen sessions for tracks that actually earn that way.
                    const ppl = await isPplPost(match.author, match.permlink);
                    if (ppl !== null) $set.ppl = ppl;

                    if (ENABLE_MONGO_WRITES) {
                        await audioCol.updateOne({ _id: audio._id }, { $set });
                    }
                    console.log(`[audioHiveSync] Linked: ${owner}/${audio.permlink} → ${match.author}/${match.permlink}${$set.genre ? ` [genre=${$set.genre}]` : ''}${$set.ppl ? ' [PPL]' : ''}`);
                    linked++;
                } else {
                    // Mark as checked so we don't re-process every run
                    // Set post_permlink to empty string to differentiate from null (unchecked)
                    if (ENABLE_MONGO_WRITES) {
                        await audioCol.updateOne(
                            { _id: audio._id },
                            { $set: { hive_link_checked: true } }
                        );
                    }
                }
            }

            // Small delay between users to avoid rate limits
            await new Promise(r => setTimeout(r, 500));
        } catch (err) {
            console.error(`[audioHiveSync] Error processing ${owner}:`, err.message, err.stack?.split('\n')[1]);
            errors++;
        }
    }

    console.log(`[audioHiveSync] Done: ${unlinked.length} checked, ${linked} linked, ${errors} errors`);
    return { checked: unlinked.length, linked, errors };
}

module.exports = { syncAudioHiveLinks };
