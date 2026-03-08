const { getDb } = require('../utils/db');

async function denormalizeCommunityTitles() {
    console.log('Starting community title denormalization...');
    const db = getDb();

    try {
        // Build lookup map: hive account name -> community title
        const communities = await db.collection('hivecommunities').find(
            {},
            { projection: { name: 1, title: 1, _id: 0 } }
        ).toArray();

        const titleMap = {};
        for (const c of communities) {
            if (c.name && c.title) titleMap[c.name] = c.title;
        }
        console.log(`Loaded ${Object.keys(titleMap).length} community titles`);

        // Update videos that have account-style hive field and missing/outdated community_title
        let totalUpdated = 0;
        const hiveNames = Object.keys(titleMap);

        for (let i = 0; i < hiveNames.length; i += 50) {
            const batch = hiveNames.slice(i, i + 50);
            const ops = batch.map(name => ({
                updateMany: {
                    filter: { hive: name, community_title: { $ne: titleMap[name] } },
                    update: { $set: { community_title: titleMap[name] } }
                }
            }));

            const result = await db.collection('videos').bulkWrite(ops);
            totalUpdated += result.modifiedCount;
        }

        console.log(`Community title denormalization complete: ${totalUpdated} videos updated`);
    } catch (error) {
        console.error('Community title denormalization failed:', error);
    }
}

module.exports = { denormalizeCommunityTitles };
