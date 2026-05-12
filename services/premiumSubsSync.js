/**
 * Premium Subscription Sync (VSC/Magi Okinoko Subs → embed-users.premium)
 *
 * Polls the Okinoko Hasura indexer for currently-active subscriptions on
 * the configured premium offer IDs (default: 4 = 1-day pass, 5 = recurring
 * sub). For every active subscriber we set `embed-users.premium = true`;
 * for every user we previously promoted via this worker who is no longer
 * active, we set `premium = false`.
 *
 * To avoid clobbering manually-set premium flags (e.g. comp accounts
 * granted by support), we tag every auto-managed row with
 * `premium_source: 'subs'` and only demote rows that carry that tag.
 * Manually-promoted rows are left alone forever.
 *
 * Schedule: server.js calls this on a 5-minute interval after a 1-minute
 * delay on boot.
 */

const { getDb } = require('../utils/db');
const { ENABLE_MONGO_WRITES } = require('../utils/config');

const HASURA_URL = process.env.OKI_HASURA_URL || 'https://api.okinoko.io/hasura/v1/graphql';
const PREMIUM_OFFER_IDS = (process.env.PREMIUM_OFFER_IDS || '4,5')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
const SUBSCRIBER_PREFIX = 'hive:';
const PREMIUM_USERS_COLLECTION = process.env.PREMIUM_USERS_COLLECTION || 'embed-users';
const SOURCE_TAG = 'subs';

async function fetchActivePremiumUsernames() {
    if (PREMIUM_OFFER_IDS.length === 0) return new Set();

    const query = `
      query ActivePremiumSubs($offerIds: [Int!]) {
        subs: oki_subs_subscription_current(
          where: {
            offer_id: { _in: $offerIds }
            status: { _eq: "active" }
          }
        ) {
          subscriber
          offer_id
          status
          next_billing_at
        }
      }
    `;

    const resp = await fetch(HASURA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { offerIds: PREMIUM_OFFER_IDS } }),
    });

    if (!resp.ok) {
        throw new Error(`Hasura HTTP ${resp.status}`);
    }

    const data = await resp.json();
    if (data.errors) {
        throw new Error(data.errors[0]?.message || 'Hasura GraphQL error');
    }

    const rows = data?.data?.subs ?? [];
    const now = Date.now();
    const usernames = new Set();

    for (const row of rows) {
        // Some offers (the 1-day one-time pass) carry their expiry in
        // next_billing_at — filter those out when expired. Recurring
        // subs without an expiry stay active per their `status` alone.
        if (row.next_billing_at) {
            const expiry = Date.parse(row.next_billing_at);
            if (Number.isFinite(expiry) && expiry < now) continue;
        }
        const id = row.subscriber || '';
        if (!id.startsWith(SUBSCRIBER_PREFIX)) continue;
        const username = id.slice(SUBSCRIBER_PREFIX.length).toLowerCase();
        if (username) usernames.add(username);
    }

    return usernames;
}

/**
 * Run one sync pass.
 * @returns {{ active: number, promoted: number, demoted: number, errors: number }}
 */
async function syncPremiumFromSubs() {
    let activeUsernames;
    try {
        activeUsernames = await fetchActivePremiumUsernames();
    } catch (err) {
        console.error('[premiumSubsSync] Hasura query failed:', err.message);
        return { active: 0, promoted: 0, demoted: 0, errors: 1 };
    }

    console.log(`[premiumSubsSync] Hasura returned ${activeUsernames.size} active premium subscribers`);

    const db = getDb();
    const col = db.collection(PREMIUM_USERS_COLLECTION);
    const now = new Date();

    let promoted = 0;
    let demoted = 0;
    let errors = 0;

    // Promote (or refresh) every currently-active subscriber. Tag the row
    // with `premium_source: 'subs'` so the demote pass below can target
    // only auto-managed rows and leave manual upgrades untouched.
    for (const username of activeUsernames) {
        try {
            if (ENABLE_MONGO_WRITES) {
                const r = await col.updateOne(
                    { username },
                    {
                        $set: {
                            premium: true,
                            premium_source: SOURCE_TAG,
                            premium_synced_at: now,
                        },
                        $setOnInsert: { username, banned: false },
                    },
                    { upsert: true },
                );
                if (r.modifiedCount > 0 || r.upsertedCount > 0) promoted++;
            }
        } catch (err) {
            console.error(`[premiumSubsSync] Promote failed for ${username}:`, err.message);
            errors++;
        }
    }

    // Demote: anyone we previously promoted (premium_source = 'subs') who
    // is no longer in the active set. Manual upgrades have a different
    // source (or none) and are deliberately skipped.
    let stale;
    try {
        stale = await col.find(
            { premium: true, premium_source: SOURCE_TAG },
            { projection: { username: 1 } },
        ).toArray();
    } catch (err) {
        console.error('[premiumSubsSync] Stale-row scan failed:', err.message);
        return { active: activeUsernames.size, promoted, demoted, errors: errors + 1 };
    }

    for (const row of stale) {
        const u = (row.username || '').toLowerCase();
        if (!u || activeUsernames.has(u)) continue;
        try {
            if (ENABLE_MONGO_WRITES) {
                await col.updateOne(
                    { _id: row._id },
                    {
                        $set: { premium: false, premium_synced_at: now },
                        $unset: { premium_source: '' },
                    },
                );
                demoted++;
            }
        } catch (err) {
            console.error(`[premiumSubsSync] Demote failed for ${u}:`, err.message);
            errors++;
        }
    }

    console.log(
        `[premiumSubsSync] Done: ${activeUsernames.size} active, ${promoted} promoted, ${demoted} demoted, ${errors} errors`,
    );

    return { active: activeUsernames.size, promoted, demoted, errors };
}

module.exports = { syncPremiumFromSubs };
