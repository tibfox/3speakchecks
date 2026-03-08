const { getDb } = require('../utils/db');
const { HIVE_RPC_ENDPOINTS } = require('../utils/config');

async function rpcCall(method, params) {
    for (const endpoint of HIVE_RPC_ENDPOINTS) {
        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
                signal: AbortSignal.timeout(15000)
            });
            const data = await resp.json();
            if (data.result) return data.result;
        } catch (err) {
            // try next endpoint
        }
    }
    return null;
}

async function syncHiveProfiles() {
    console.log('Starting Hive profile sync...');
    const db = getDb();
    const profileCollection = db.collection('hiveprofiles');

    try {
        // Get all unique content creators
        const [vidOwners, embedOwners] = await Promise.all([
            db.collection('videos').distinct('owner'),
            db.collection('embed-video').distinct('owner')
        ]);
        const usernames = [...new Set([...vidOwners, ...embedOwners])].filter(Boolean);
        console.log(`Found ${usernames.length} unique creators to sync profiles for`);

        let totalSynced = 0;

        // Fetch in batches of 1000 (Hive API limit for get_accounts)
        for (let i = 0; i < usernames.length; i += 1000) {
            const batch = usernames.slice(i, i + 1000);
            const accounts = await rpcCall('condenser_api.get_accounts', [batch]);
            if (!accounts) {
                console.error(`Profile fetch failed for batch ${i}-${i + batch.length}`);
                continue;
            }

            const ops = [];
            for (const acct of accounts) {
                let profile = {};
                try {
                    const meta = JSON.parse(acct.posting_json_metadata || acct.json_metadata || '{}');
                    profile = meta.profile || {};
                } catch (e) { /* ignore */ }

                ops.push({
                    updateOne: {
                        filter: { username: acct.name },
                        update: {
                            $set: {
                                username: acct.name,
                                display_name: profile.name || '',
                                about: profile.about || '',
                                location: profile.location || '',
                                website: profile.website || '',
                                profile_image: profile.profile_image || '',
                                cover_image: profile.cover_image || '',
                                updated_at: new Date()
                            }
                        },
                        upsert: true
                    }
                });
            }

            if (ops.length > 0) {
                await profileCollection.bulkWrite(ops);
                totalSynced += ops.length;
            }

            console.log(`Profile sync progress: ${Math.min(i + 1000, usernames.length)}/${usernames.length}`);
        }

        console.log(`Profile sync complete: ${totalSynced} profiles synced`);
    } catch (error) {
        console.error('Profile sync failed:', error);
    }
}

module.exports = { syncHiveProfiles };
