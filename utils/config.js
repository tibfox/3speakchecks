const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

module.exports = {
    PORT: process.env.PORT || 3000,
    MONGODB_URI: process.env.MONGODB_URI,
    DATABASE_NAME: process.env.DATABASE_NAME || 'threespeak',
    COLLECTION_NAME: process.env.COLLECTION_NAME || 'contentcreators',
    API_SECRET_KEY: process.env.API_SECRET_KEY,
    ENABLE_MONGO_WRITES: process.env.ENABLE_MONGO_WRITES !== 'false',
    SHORT_SORT_INTERVAL: parseInt(process.env.SHORT_SORT_INTERVAL) || 2,
    HIVE_RPC_ENDPOINTS: (process.env.HIVE_RPC_ENDPOINTS || process.env.HIVE_RPC_ENDPOINT || 'https://techcoderx.com,https://api.deathwing.me,https://api.hive.blog')
        .split(',').map(s => s.trim()).filter(Boolean),
    REWARD_WEIGHT: parseFloat(process.env.REWARD_WEIGHT) || 0.7,
    RESHARE_WEIGHT: parseFloat(process.env.RESHARE_WEIGHT) || 0.15,
    TRENDING_VIEWS_WEIGHT: parseFloat(process.env.TRENDING_VIEWS_WEIGHT) || 1,
    TRENDING_VOTES_WEIGHT: parseFloat(process.env.TRENDING_VOTES_WEIGHT) || 2,
    TRENDING_COMMENTS_WEIGHT: parseFloat(process.env.TRENDING_COMMENTS_WEIGHT) || 3,
    TRENDING_REWARD_WEIGHT: parseFloat(process.env.TRENDING_REWARD_WEIGHT) || 10,
    TRENDING_RESHARE_WEIGHT: parseFloat(process.env.TRENDING_RESHARE_WEIGHT) || 5,
    TRENDING_CANDIDATE_LIMIT: parseInt(process.env.TRENDING_CANDIDATE_LIMIT) || 200,
    HIDDEN_AUTHORS: (process.env.HIDDEN_AUTHORS || 'threespeak-fixer')
        .split(',').map(s => s.trim()).filter(Boolean),
};
