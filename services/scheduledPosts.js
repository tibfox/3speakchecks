/**
 * Scheduled posts worker.
 *
 * Posts that users have queued for later are stored in the `scheduled-posts`
 * Mongo collection by routes/scheduledPosts.js. This worker polls the
 * collection every N minutes for posts whose `scheduledOn` is due and whose
 * `status` is "scheduled", then broadcasts them to Hive as the original user
 * — signed with the THREESPEAK account's posting key. For that signature to
 * be accepted, the user must have added `threespeak` to their posting
 * account_auths (the frontend handles that before saving the schedule).
 *
 * Entirely env-gated: schedule() is a no-op if THREESPEAK_POSTING_KEY is
 * missing OR SCHEDULED_POSTS_RUNNER !== 'true'. Only ONE checker instance
 * should run the worker (or jobs get double-broadcast).
 */

const { Client, PrivateKey } = require('@hiveio/dhive');
const { ObjectId } = require('mongodb');
const { getDb } = require('../utils/db');
const { HIVE_RPC_ENDPOINTS } = require('../utils/config');

const THREESPEAK_USERNAME = process.env.THREESPEAK_USERNAME || 'threespeak';
const THREESPEAK_POSTING_KEY = process.env.THREESPEAK_POSTING_KEY || '';
const RUNNER_ENABLED = process.env.SCHEDULED_POSTS_RUNNER === 'true';
const INTERVAL_MIN = Math.max(1, parseInt(process.env.SCHEDULED_POSTS_INTERVAL_MIN || '5', 10));
const MAX_ATTEMPTS = 3;
const COLLECTION = 'scheduled-posts';

// Embed service hook — after broadcasting the Hive post, link the embed video
// record so the embed_url / hive_author / hive_permlink point at the new post.
// All env-driven: if either is missing, we skip the link step (broadcast still
// succeeds — the user just gets an embed-video without the hive_* fields set).
const EMBED_API_URL = (process.env.EMBED_API_URL || '').replace(/\/$/, '');
const EMBED_API_KEY = process.env.EMBED_API_KEY || '';

let client;
let postingKey;

function getClient() {
    if (!client) client = new Client(HIVE_RPC_ENDPOINTS);
    return client;
}

function getKey() {
    if (!postingKey) postingKey = PrivateKey.fromString(THREESPEAK_POSTING_KEY);
    return postingKey;
}

/**
 * On-chain authorization check: has `owner` granted @threespeak posting authority?
 * This is what makes app-key auth on the create route safe — a scheduled post can
 * only ever be queued for a user who opted into @threespeak, and the cron can only
 * broadcast on their behalf because of this exact grant.
 */
async function hasThreespeakPostingAuthority(owner) {
    const [account] = await getClient().database.getAccounts([owner]);
    if (!account) return false;
    const posting = account.posting || {};
    const auths = posting.account_auths || [];
    const grant = auths.find(([acc]) => acc === THREESPEAK_USERNAME);
    return !!grant && grant[1] >= (posting.weight_threshold || 1);
}

/**
 * Build the comment + comment_options operations from a stored doc.
 * Returns an array of dhive Operation tuples ready for sendOperations.
 */
function buildOperations(doc) {
    const ops = [];

    ops.push([
        'comment',
        {
            parent_author: doc.parentAuthor || '',
            parent_permlink: doc.parentPermlink || 'hive-181335',
            author: doc.owner,
            permlink: doc.permlink,
            title: doc.title || '',
            body: doc.body || '',
            json_metadata: typeof doc.jsonMetadata === 'string'
                ? doc.jsonMetadata
                : JSON.stringify(doc.jsonMetadata || {}),
        },
    ]);

    // comment_options — beneficiaries + payout shape.
    // payoutOptions: 'default' (50/50 SBD-HP) | 'powerup' (100% HP) | 'decline' (decline payout).
    const payoutOption = (doc.payoutOptions || 'default').toLowerCase();
    const declinePayout = payoutOption === 'decline';
    const percentHbd = payoutOption === 'powerup' ? 0 : 10000; // 0 = 100% HP, 10000 = 50/50 (legacy SBD label)
    const maxAcceptedPayout = declinePayout ? '0.000 HBD' : '1000000.000 HBD';

    const extensions = [];
    const benes = Array.isArray(doc.beneficiaries) ? doc.beneficiaries : [];
    // Skip the beneficiaries extension when declining payout — emitting an empty
    // beneficiaries array against a 0 HBD payout is awkward on-chain.
    if (!declinePayout && benes.length > 0) {
        extensions.push([
            0,
            {
                beneficiaries: benes
                    .filter(b => b && b.account && Number.isFinite(b.weight))
                    .map(b => ({ account: b.account, weight: b.weight })),
            },
        ]);
    }

    ops.push([
        'comment_options',
        {
            author: doc.owner,
            permlink: doc.permlink,
            max_accepted_payout: maxAcceptedPayout,
            percent_hbd: percentHbd,
            allow_votes: true,
            allow_curation_rewards: true,
            extensions,
        },
    ]);

    return ops;
}

async function broadcastPost(doc) {
    const ops = buildOperations(doc);
    return getClient().broadcast.sendOperations(ops, getKey());
}

/**
 * After successfully broadcasting, tell the embed service that the embed
 * video now has a Hive post attached. Non-fatal — if the link fails we log
 * and continue (the broadcast itself is the source of truth).
 *
 * Two-step: first the /hive endpoint sets hive_author/hive_permlink/embed_url
 * + Hive metadata; then the /thumbnail endpoint sets thumbnail_url. The split
 * mirrors how the live upload flow calls these from the frontend — for live
 * uploads the thumbnail endpoint is hit immediately after the image is uploaded,
 * so without the second call here scheduled uploads end up with a null
 * thumbnail_url on the embed-video record (visible as "no thumbnail" on the
 * author's profile, even though the on-chain post has the image).
 */
async function linkEmbedVideoToHivePost(doc) {
    if (!doc.embedPermlink || !EMBED_API_URL || !EMBED_API_KEY) return;

    // 1. /hive — link the broadcast Hive post to the embed-video record.
    try {
        const url = `${EMBED_API_URL}/video/${encodeURIComponent(doc.embedPermlink)}/hive`;
        const body = {
            hive_author: doc.owner,
            hive_permlink: doc.permlink,
            hive_title: doc.title || '',
            hive_body: doc.body || '',
            hive_tags: Array.isArray(doc.tags) ? doc.tags : [],
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': EMBED_API_KEY },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            console.warn(`[scheduledPosts] embed-link /hive non-2xx for ${doc.owner}/${doc.permlink}: ${res.status} ${txt}`);
        } else {
            console.log(`[scheduledPosts] linked embed video ${doc.embedPermlink} -> @${doc.owner}/${doc.permlink}`);
        }
    } catch (err) {
        console.warn(`[scheduledPosts] embed-link /hive error for ${doc.owner}/${doc.permlink}:`, err.message || err);
    }

    // 2. /thumbnail — set thumbnail_url so the embed-video record matches what the
    // on-chain post advertises. Skipped silently if the schedule has no thumbnail.
    if (!doc.thumbnail) return;
    try {
        const url = `${EMBED_API_URL}/video/${encodeURIComponent(doc.embedPermlink)}/thumbnail`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': EMBED_API_KEY },
            body: JSON.stringify({ thumbnail_url: doc.thumbnail }),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            console.warn(`[scheduledPosts] embed-link /thumbnail non-2xx for ${doc.owner}/${doc.permlink}: ${res.status} ${txt}`);
        } else {
            console.log(`[scheduledPosts] set thumbnail_url for ${doc.embedPermlink}`);
        }
    } catch (err) {
        console.warn(`[scheduledPosts] embed-link /thumbnail error for ${doc.owner}/${doc.permlink}:`, err.message || err);
    }
}

/**
 * Atomically claim a single due post (status: scheduled → processing) and
 * return the original doc. Returns null if nothing to claim. The atomic
 * findOneAndUpdate prevents two ticks (or two replicas) from racing.
 */
async function claimNextDuePost(coll) {
    const now = new Date();
    // Strict claim filter: only ever claim docs that are explicitly status:scheduled,
    // are due (scheduledOn elapsed), still under the attempt cap, AND have non-empty
    // string owner/permlink. The owner/permlink check is defense-in-depth so a
    // malformed doc can never become a broadcast op.
    const res = await coll.findOneAndUpdate(
        {
            status: 'scheduled',
            scheduledOn: { $lte: now },
            attempts: { $lt: MAX_ATTEMPTS },
            owner: { $type: 'string', $ne: '' },
            permlink: { $type: 'string', $ne: '' },
        },
        {
            $set: { status: 'processing', processingStartedAt: now, updatedAt: now },
            $inc: { attempts: 1 },
        },
        { sort: { scheduledOn: 1 }, returnDocument: 'before' },
    );
    return res && (res.value || res); // driver shape varies — handle both
}

/**
 * Sanity-check a claimed doc before we sign anything. If this throws, the doc
 * is marked failed without ever being broadcast — the @threespeak posting key
 * stays unused for malformed entries. Belt-and-braces alongside the strict
 * claim filter.
 */
function validateClaimedDoc(doc) {
    if (!doc || typeof doc !== 'object') throw new Error('claimed doc is not an object');
    if (typeof doc.owner !== 'string' || !doc.owner.trim()) throw new Error('doc.owner missing or empty');
    if (typeof doc.permlink !== 'string' || !doc.permlink.trim()) throw new Error('doc.permlink missing or empty');
    if (doc.status !== 'processing') throw new Error(`doc.status is "${doc.status}", expected "processing"`);
    if (typeof doc.body !== 'string' || !doc.body.trim()) throw new Error('doc.body missing or empty');
    // Title may be empty (Hive allows it for reply-style posts) but must be a string.
    if (doc.title != null && typeof doc.title !== 'string') throw new Error('doc.title must be a string');
}

async function runOnce() {
    if (!RUNNER_ENABLED || !THREESPEAK_POSTING_KEY) return;

    const db = await getDb();
    const coll = db.collection(COLLECTION);

    // Process up to N posts per tick so a flood doesn't stall the loop.
    const PER_TICK = 10;
    for (let i = 0; i < PER_TICK; i++) {
        const doc = await claimNextDuePost(coll);
        if (!doc) return;

        // After the atomic claim doc.status is "scheduled" in the snapshot we
        // returned, but in the DB it's now "processing" — re-stamp here so the
        // validator sees the post-claim state, then validate before signing.
        doc.status = 'processing';
        try {
            validateClaimedDoc(doc);
        } catch (validationErr) {
            await coll.updateOne(
                { _id: doc._id },
                {
                    $set: {
                        status: 'failed',
                        lastError: `validation: ${validationErr.message}`,
                        updatedAt: new Date(),
                    },
                },
            );
            console.error(
                `[scheduledPosts] skipped malformed doc ${doc.owner || '?'}/${doc.permlink || '?'} (id=${doc._id}): ${validationErr.message}`,
            );
            continue;
        }

        try {
            const tx = await broadcastPost(doc);
            await coll.updateOne(
                { _id: doc._id },
                {
                    $set: {
                        status: 'posted',
                        postedAt: new Date(),
                        broadcastTxId: tx && tx.id ? tx.id : null,
                        lastError: null,
                        updatedAt: new Date(),
                    },
                },
            );
            console.log(`[scheduledPosts] posted ${doc.owner}/${doc.permlink} (tx=${tx && tx.id})`);
            await linkEmbedVideoToHivePost(doc);
        } catch (err) {
            const attempts = (doc.attempts || 0) + 1; // we already incremented above
            const final = attempts >= MAX_ATTEMPTS;
            await coll.updateOne(
                { _id: doc._id },
                {
                    $set: {
                        status: final ? 'failed' : 'scheduled', // back to scheduled to retry on next tick
                        lastError: err && err.message ? err.message : String(err),
                        updatedAt: new Date(),
                    },
                },
            );
            console.error(
                `[scheduledPosts] broadcast error for ${doc.owner}/${doc.permlink} (attempt ${attempts}/${MAX_ATTEMPTS}):`,
                err.message || err,
            );
        }
    }
}

async function ensureIndexes() {
    const db = await getDb();
    const coll = db.collection(COLLECTION);
    try {
        await coll.createIndex({ owner: 1, status: 1, scheduledOn: 1 }, { name: 'sched_owner_status_date' });
        await coll.createIndex({ status: 1, scheduledOn: 1 }, { name: 'sched_due' });
        await coll.createIndex({ owner: 1, permlink: 1 }, { unique: true, name: 'sched_owner_permlink' });
    } catch (err) {
        console.error('[scheduledPosts] index create error:', err.message || err);
    }
}

function schedule() {
    if (!RUNNER_ENABLED) {
        console.log('[scheduledPosts] runner disabled — set SCHEDULED_POSTS_RUNNER=true to enable.');
        return;
    }
    if (!THREESPEAK_POSTING_KEY) {
        console.log('[scheduledPosts] disabled — THREESPEAK_POSTING_KEY missing.');
        return;
    }
    try {
        getKey(); // surface a bad key at boot, not on first tick.
    } catch (err) {
        console.error('[scheduledPosts] disabled — could not parse THREESPEAK_POSTING_KEY:', err.message);
        return;
    }

    ensureIndexes().catch((err) => console.error('[scheduledPosts] ensureIndexes error:', err));

    console.log(`[scheduledPosts] scheduled every ${INTERVAL_MIN}min as @${THREESPEAK_USERNAME} (first tick in 30s)`);
    setTimeout(() => {
        runOnce().catch((err) => console.error('[scheduledPosts] tick error:', err));
        setInterval(() => {
            runOnce().catch((err) => console.error('[scheduledPosts] tick error:', err));
        }, INTERVAL_MIN * 60 * 1000);
    }, 30 * 1000);
}

module.exports = { schedule, runOnce, COLLECTION, hasThreespeakPostingAuthority };
