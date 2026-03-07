const { getDb } = require('../utils/db');
const { HIVE_RPC_ENDPOINTS } = require('../utils/config');

async function syncHiveCommunities() {
    console.log('Starting Hive community sync...');
    const db = getDb();
    const commCollection = db.collection('hivecommunities');
    let totalSynced = 0;
    let last = '';

    try {
        // Paginate through all communities via bridge.list_communities
        while (true) {
            const params = { limit: 100, sort: 'rank' };
            if (last) params.last = last;

            let listResult;
            for (const endpoint of HIVE_RPC_ENDPOINTS) {
                try {
                    const resp = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jsonrpc: '2.0', method: 'bridge.list_communities', params, id: 1 }),
                        signal: AbortSignal.timeout(15000)
                    });
                    const data = await resp.json();
                    listResult = data.result;
                    break;
                } catch (err) {
                    console.error(`Community list fetch failed for ${endpoint}:`, err.message);
                }
            }

            if (!listResult || listResult.length === 0) break;

            // Fetch full details (with description) in batches of 10
            for (let i = 0; i < listResult.length; i += 10) {
                const batch = listResult.slice(i, i + 10);
                const details = await Promise.all(batch.map(async (comm) => {
                    for (const endpoint of HIVE_RPC_ENDPOINTS) {
                        try {
                            const resp = await fetch(endpoint, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ jsonrpc: '2.0', method: 'bridge.get_community', params: { name: comm.name }, id: 1 }),
                                signal: AbortSignal.timeout(10000)
                            });
                            const data = await resp.json();
                            if (data.result) return data.result;
                        } catch (err) {
                            // silently try next endpoint
                        }
                    }
                    console.error(`Community detail fetch failed for ${comm.name}: all endpoints failed`);
                    return null;
                }));

                const ops = details.filter(Boolean).map(d => ({
                    updateOne: {
                        filter: { name: d.name },
                        update: {
                            $set: {
                                title: d.title,
                                about: d.about || '',
                                description: d.description || '',
                                lang: d.lang || 'en',
                                is_nsfw: d.is_nsfw || false,
                                subscribers: d.subscribers || 0,
                                num_authors: d.num_authors || 0,
                                sum_pending: d.sum_pending || 0,
                                used: true
                            }
                        },
                        upsert: true
                    }
                }));

                if (ops.length > 0) {
                    await commCollection.bulkWrite(ops);
                    totalSynced += ops.length;
                }
            }

            last = listResult[listResult.length - 1].name;
            if (listResult.length < 100) break;
        }

        console.log(`Community sync complete: ${totalSynced} communities synced`);
    } catch (error) {
        console.error('Community sync failed:', error);
    }
}

module.exports = { syncHiveCommunities };
