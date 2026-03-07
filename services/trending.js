const { getDb } = require('../utils/db');
const { BANNED_FILTER } = require('../utils/filters');
const { ENABLE_MONGO_WRITES, HIDDEN_AUTHORS, TRENDING_VIEWS_WEIGHT, TRENDING_VOTES_WEIGHT, TRENDING_COMMENTS_WEIGHT, TRENDING_REWARD_WEIGHT } = require('../utils/config');

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

        // Calculate trending scores and get top 50 videos
        const trendingVideos = await videosCollection.aggregate([
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
                            { $multiply: [{ $ifNull: ['$stats.num_comments', 0] }, TRENDING_COMMENTS_WEIGHT] },
                            { $multiply: [{ $ifNull: ['$stats.total_hive_reward', 0] }, TRENDING_REWARD_WEIGHT] }
                        ]
                    }
                }
            },
            { $sort: { trending_score: -1 } },
            { $limit: 50 }
        ]).toArray();

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
