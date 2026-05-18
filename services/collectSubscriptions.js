/**
 * Periodic collect_subscriptions trigger for the Okinoko Subs contract.
 *
 * Once per COLLECT_SUBS_INTERVAL_HOURS (default 1h), broadcasts a
 * custom_json `vsc.call` op with action="collect_subscriptions" against
 * each configured offer ID. The contract iterates over the offer's
 * subscribers and bills any whose next_billing_at has passed by drawing
 * from their prepaid balance and transferring the interval price to
 * the provider. Subscribers with insufficient balance get marked
 * inactive (status flips), which our premiumSubsSync worker then picks
 * up on its next pass and demotes premium for.
 *
 * Authorization: only the offer provider can call collect_subscriptions.
 * The provider account is `THREESPEAK_PRO_USERNAME`; we sign with its
 * posting key (custom_json with no transfer.allow intent — posting is
 * sufficient and minimises blast radius if the key leaks).
 *
 * Gated entirely on env: schedule() is a no-op when either
 * THREESPEAK_PRO_USERNAME or THREESPEAK_PRO_POSTING_KEY is unset, so
 * deployments without provider credentials simply don't run this.
 */

const { Client, PrivateKey } = require('@hiveio/dhive');
const { HIVE_RPC_ENDPOINTS } = require('../utils/config');

const PROVIDER_USERNAME = (process.env.THREESPEAK_PRO_USERNAME || '').trim();
const PROVIDER_POSTING_KEY = (process.env.THREESPEAK_PRO_POSTING_KEY || '').trim();

const VSC_NET_ID = process.env.VSC_NET_ID || 'vsc-mainnet';
const VSC_SUBS_CONTRACT_ID =
    process.env.VSC_SUBS_CONTRACT_ID || 'vsc1BpkPNtC1pBLhxtNn4uE3QkLhudoyzAiXUi';

const COLLECT_OFFER_IDS = (process.env.COLLECT_SUBS_OFFER_IDS || '5')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const COLLECT_INTERVAL_HOURS = parseFloat(process.env.COLLECT_SUBS_INTERVAL_HOURS || '1');
const COLLECT_INTERVAL_MS = Math.max(60_000, COLLECT_INTERVAL_HOURS * 60 * 60 * 1000);

const RC_LIMIT = parseInt(process.env.COLLECT_SUBS_RC_LIMIT || '50000', 10);

let hiveClient = null;
let postingKey = null;

function getClient() {
    if (hiveClient) return hiveClient;
    // dhive's Client accepts an array of RPC URLs and rotates on failure.
    // Filter to HTTPS Hive mainnet nodes — the checker config carries some
    // testnet nodes for read-only queries that we don't want to use for
    // signed broadcasts.
    const nodes = HIVE_RPC_ENDPOINTS.filter((u) => /^https?:\/\//.test(u) && !/testnet/.test(u));
    hiveClient = new Client(nodes.length ? nodes : ['https://api.hive.blog']);
    return hiveClient;
}

function getKey() {
    if (postingKey) return postingKey;
    postingKey = PrivateKey.fromString(PROVIDER_POSTING_KEY);
    return postingKey;
}

async function collectOnce(offerId) {
    const json = JSON.stringify({
        net_id: VSC_NET_ID,
        contract_id: VSC_SUBS_CONTRACT_ID,
        action: 'collect_subscriptions',
        payload: String(offerId),
        rc_limit: RC_LIMIT,
        intents: [],
    });

    const op = [
        'custom_json',
        {
            required_auths: [],
            required_posting_auths: [PROVIDER_USERNAME],
            id: 'vsc.call',
            json,
        },
    ];

    const result = await getClient().broadcast.sendOperations([op], getKey());
    return result;
}

async function runCollect() {
    if (!PROVIDER_USERNAME || !PROVIDER_POSTING_KEY) {
        // Should never happen — schedule() guards this — but defensive.
        return;
    }

    for (const offerId of COLLECT_OFFER_IDS) {
        try {
            const r = await collectOnce(offerId);
            const txId = r?.id || '(no id)';
            console.log(`[collectSubs] offer ${offerId} → broadcast OK (tx ${txId})`);
        } catch (err) {
            // Common, non-fatal cases: nothing due (contract no-op), RC out, RPC blip.
            const msg = err?.message || String(err);
            console.error(`[collectSubs] offer ${offerId} → broadcast failed: ${msg}`);
        }
    }
}

/**
 * Wire the worker into the server boot sequence. No-op when env is
 * incomplete so deployments without provider credentials skip silently.
 */
function schedule() {
    if (!PROVIDER_USERNAME || !PROVIDER_POSTING_KEY) {
        console.log(
            '[collectSubs] disabled — set THREESPEAK_PRO_USERNAME and THREESPEAK_PRO_POSTING_KEY to enable.',
        );
        return;
    }

    // Validate the key parses before scheduling, so a misconfigured key
    // surfaces at boot rather than every hour.
    try {
        getKey();
    } catch (err) {
        console.error(`[collectSubs] disabled — could not parse THREESPEAK_PRO_POSTING_KEY: ${err.message}`);
        return;
    }

    const offerList = COLLECT_OFFER_IDS.join(', ');
    console.log(
        `[collectSubs] scheduled every ${COLLECT_INTERVAL_HOURS}h for offer(s) ${offerList} as @${PROVIDER_USERNAME} (first run in 5min)`,
    );

    setTimeout(() => {
        runCollect().catch((err) => console.error('[collectSubs] tick error:', err));
        setInterval(() => {
            runCollect().catch((err) => console.error('[collectSubs] tick error:', err));
        }, COLLECT_INTERVAL_MS);
    }, 5 * 60 * 1000);
}

module.exports = { schedule, runCollect };
