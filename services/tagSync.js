/**
 * Watches the embed-video collection for inserts/updates and keeps
 * hive_tags_lower in sync with hive_tags automatically.
 *
 * Requires MongoDB replica set (change streams need oplog).
 */
const { getDb } = require('../utils/db');

function startTagSyncWatcher() {
    const db = getDb();
    const col = db.collection('embed-video');

    const pipeline = [
        {
            $match: {
                $or: [
                    { operationType: 'insert' },
                    { operationType: 'replace' },
                    { 'updateDescription.updatedFields.hive_tags': { $exists: true } },
                ],
            },
        },
    ];

    const stream = col.watch(pipeline, { fullDocument: 'updateLookup' });

    stream.on('change', async (change) => {
        try {
            const doc = change.fullDocument;
            if (!doc || !doc.hive_tags) return;

            const lower = doc.hive_tags.map(t => t.toLowerCase());

            // Skip if already in sync
            if (
                Array.isArray(doc.hive_tags_lower) &&
                doc.hive_tags_lower.length === lower.length &&
                doc.hive_tags_lower.every((v, i) => v === lower[i])
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
        // Restart after a delay
        setTimeout(() => {
            console.log('[tagSync] Restarting change stream...');
            startTagSyncWatcher();
        }, 5000);
    });

    console.log('[tagSync] Watching embed-video for hive_tags changes');
}

module.exports = { startTagSyncWatcher };
