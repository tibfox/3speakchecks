/**
 * Watches the embed-video collection for inserts/updates and keeps
 * hive_tags_lower in sync with hive_tags automatically.
 *
 * Requires MongoDB replica set (change streams need oplog).
 */
const { getDb } = require('../utils/db');

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 5000;

function startTagSyncWatcher() {
    const db = getDb();
    const col = db.collection('embed-video');
    let retries = 0;
    let stream = null;

    function open() {
        // Filter to inserts, replaces, and updates that touch hive_tags
        // Exclude updates that ONLY set hive_tags_lower (our own writes)
        const pipeline = [
            {
                $match: {
                    $or: [
                        { operationType: 'insert' },
                        { operationType: 'replace' },
                        {
                            operationType: 'update',
                            'updateDescription.updatedFields.hive_tags': { $exists: true },
                        },
                    ],
                },
            },
        ];

        stream = col.watch(pipeline, { fullDocument: 'updateLookup' });

        stream.on('change', async (change) => {
            // Reset retries on any successful event
            retries = 0;

            try {
                const doc = change.fullDocument;
                if (!doc) return;

                const hiveTags = doc.hive_tags;
                const lower = Array.isArray(hiveTags) && hiveTags.length > 0
                    ? hiveTags.map(t => (typeof t === 'string' ? t.toLowerCase() : String(t)))
                    : [];

                // Skip if already in sync
                const existing = doc.hive_tags_lower;
                if (
                    Array.isArray(existing) &&
                    existing.length === lower.length &&
                    existing.every((v, i) => v === lower[i])
                ) return;

                await col.updateOne(
                    { _id: doc._id },
                    { $set: { hive_tags_lower: lower } },
                );
            } catch (err) {
                console.error('[tagSync] Error syncing hive_tags_lower:', err.message);
            }
        });

        stream.on('error', (err) => {
            console.error('[tagSync] Change stream error:', err.message);
            cleanup();

            retries++;
            if (retries > MAX_RETRIES) {
                console.error(`[tagSync] Giving up after ${MAX_RETRIES} retries. Tag sync is disabled — hive_tags_lower will not auto-update.`);
                return;
            }

            const delay = BASE_DELAY_MS * retries;
            console.log(`[tagSync] Retry ${retries}/${MAX_RETRIES} in ${delay / 1000}s...`);
            setTimeout(open, delay);
        });

        console.log('[tagSync] Watching embed-video for hive_tags changes');
    }

    function cleanup() {
        if (stream) {
            stream.removeAllListeners();
            stream.close().catch(() => {});
            stream = null;
        }
    }

    open();
}

module.exports = { startTagSyncWatcher };
