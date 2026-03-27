const { getDb } = require('../utils/db');
const { BANNED_FILTER } = require('../utils/filters');
const { ENABLE_MONGO_WRITES, HIDDEN_AUTHORS, TRENDING_VIEWS_WEIGHT, TRENDING_VOTES_WEIGHT, TRENDING_COMMENTS_WEIGHT, TRENDING_REWARD_WEIGHT } = require('../utils/config');
const { fetchHiveRewards } = require('../utils/hive');

async function calculateAndFlagTrendingVideos() {
    if (!ENABLE_MONGO_WRITES) {
        console.log('Skipping trending calculation (ENABLE_MONGO_WRITES=false)');
        return;
    }
    try {
        const db = getDb();
        console.log('Calculating trending videos...');
        const videosCollection = db.collection('videos');

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // First, unflag all current trending videos
        await videosCollection.updateMany(
            { trending: true },
            { $set: { trending: false } }
        );

        // Fetch candidates with partial score (without reward — reward will be fetched live)
        const candidates = await videosCollection.aggregate([
            {
                $match: {
                    status: 'published',
                    ...BANNED_FILTER,
                    owner: { $nin: HIDDEN_AUTHORS },
                    created: { $gte: sevenDaysAgo }
                }
            },
            {
                $addFields: {
                    trending_score: {
                        $add: [
                            { $multiply: [{ $ifNull: ['$views', 0] }, TRENDING_VIEWS_WEIGHT] },
                            { $multiply: [{ $ifNull: ['$stats.num_votes', 0] }, TRENDING_VOTES_WEIGHT] },
                            { $multiply: [{ $ifNull: ['$stats.num_comments', 0] }, TRENDING_COMMENTS_WEIGHT] }
                        ]
                    }
                }
            },
            { $sort: { trending_score: -1 } },
            { $limit: 200 }
        ]).toArray();

        // Fetch live Hive rewards for all candidates
        const authorPerms = candidates
            .filter(v => (v.author || v.owner) && v.permlink)
            .map(v => ({ author: v.author || v.owner, permlink: v.permlink }));

        let hiveData = new Map();
        if (authorPerms.length > 0) {
            hiveData = await fetchHiveRewards(authorPerms);
        }

        // Recalculate trending_score with live reward data
        for (const video of candidates) {
            const hiveKey = `${video.author || video.owner}/${video.permlink}`;
            const hive = hiveData.get(hiveKey);
            const liveReward = hive ? (hive.reward || 0) : 0;
            video.trending_score = (video.trending_score || 0) + liveReward * TRENDING_REWARD_WEIGHT;
        }

        // Sort by final score and take top 50
        candidates.sort((a, b) => b.trending_score - a.trending_score);
        const trendingVideos = candidates.slice(0, 50);

        if (trendingVideos.length > 0) {
            const trendingIds = trendingVideos.map(v => v._id);
            await videosCollection.updateMany(
                { _id: { $in: trendingIds } },
                { $set: { trending: true } }
            );
            console.log(`Flagged ${trendingVideos.length} videos as trending`);
        } else {
            console.log('No trending videos found');
        }

    } catch (error) {
        console.error('Error calculating trending videos:', error);
    }
}

module.exports = { calculateAndFlagTrendingVideos };
