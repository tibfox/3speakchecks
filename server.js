const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { PORT } = require('./utils/config');
const { connectToMongo } = require('./utils/db');
const { calculateAndFlagTrendingVideos } = require('./services/trending');
const { syncHiveCommunities } = require('./services/communitySync');
const { syncHiveProfiles } = require('./services/profileSync');

// Routes
const healthRoutes = require('./routes/health');
const searchRoutes = require('./routes/search');
const userRoutes = require('./routes/user');
const videosRoutes = require('./routes/videos');
const shortsRoutes = require('./routes/shorts');
const audioRoutes = require('./routes/audio');
const feedsRoutes = require('./routes/feeds');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Mount routes
app.use('/', healthRoutes);
app.use('/search', searchRoutes);
app.use('/', userRoutes);
app.use('/', videosRoutes);
app.use('/', shortsRoutes);
app.use('/audio', audioRoutes);
app.use('/feeds', feedsRoutes);

// Start server
async function startServer() {
    await connectToMongo();

    // Initialize trending videos on startup
    console.log('Initializing trending videos...');
    await calculateAndFlagTrendingVideos();

    // Schedule trending calculation to run every 15 minutes
    cron.schedule('*/15 * * * *', () => {
        console.log('Running scheduled trending calculation...');
        calculateAndFlagTrendingVideos();
    });
    console.log('Trending calculation scheduled to run every 15 minutes');

    // Sync communities and profiles on startup (non-blocking) and daily at 3 AM
    syncHiveCommunities();
    syncHiveProfiles();
    cron.schedule('0 3 * * *', () => {
        console.log('Running scheduled community sync...');
        syncHiveCommunities();
        console.log('Running scheduled profile sync...');
        syncHiveProfiles();
    });
    console.log('Community + profile sync scheduled to run daily at 3 AM');

    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
        console.log(`Health check: http://localhost:${PORT}`);
        console.log(`Check user: http://localhost:${PORT}/check/{username}`);
    });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    process.exit(0);
});

startServer().catch(console.error);
