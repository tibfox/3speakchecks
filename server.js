const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { PORT, TRENDING_INTERVAL_MIN, COMMUNITY_SYNC_DELAY_H, COMMUNITY_SYNC_INTERVAL_H, PROFILE_SYNC_DELAY_H, PROFILE_SYNC_INTERVAL_H } = require('./utils/config');
const { connectToMongo } = require('./utils/db');
const { calculateAndFlagTrendingVideos } = require('./services/trending');
const { syncHiveCommunities } = require('./services/communitySync');
const { syncHiveProfiles } = require('./services/profileSync');
const { denormalizeCommunityTitles } = require('./services/communityDenorm');
const { startTagSyncWatcher } = require('./services/tagSync');
const { syncAudioHiveLinks } = require('./services/audioHiveSync');

// Routes
const healthRoutes = require('./routes/health');
const searchRoutes = require('./routes/search');
const userRoutes = require('./routes/user');
const videosRoutes = require('./routes/videos');
const shortsRoutes = require('./routes/shorts');
const audioRoutes = require('./routes/audio');
const feedsRoutes = require('./routes/feeds');
const rssRoutes = require('./routes/rss');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files (XSL stylesheet for RSS feed viewer, etc.)
app.use(express.static('public'));


// Mount routes
app.use('/', healthRoutes);
app.use('/search', searchRoutes);
app.use('/', userRoutes);
app.use('/', videosRoutes);
app.use('/', shortsRoutes);
app.use('/audio', audioRoutes);
app.use('/feeds', feedsRoutes);
app.use('/rss', rssRoutes);

// Track whether heavy sync tasks are running
let syncRunning = false;

// Start server
async function startServer() {
    await connectToMongo();

    // Start change stream watcher to keep hive_tags_lower in sync
    startTagSyncWatcher();

    // Initialize trending videos on startup
    console.log('Initializing trending videos...');
    await calculateAndFlagTrendingVideos();

    // Schedule trending calculation (skip if a sync is running)
    cron.schedule(`*/${TRENDING_INTERVAL_MIN} * * * *`, () => {
        if (syncRunning) {
            console.log('Skipping trending calculation — sync in progress');
            return;
        }
        console.log('Running scheduled trending calculation...');
        calculateAndFlagTrendingVideos();
    });
    console.log(`Trending calculation scheduled every ${TRENDING_INTERVAL_MIN} minutes`);

    // Sync communities (delayed after startup, then on interval)
    const commDelayMs = COMMUNITY_SYNC_DELAY_H * 60 * 60 * 1000;
    const commIntervalMs = COMMUNITY_SYNC_INTERVAL_H * 60 * 60 * 1000;
    setTimeout(() => {
        const runCommunitySync = async () => {
            syncRunning = true;
            console.log('Running community sync...');
            try {
                await syncHiveCommunities();
                await denormalizeCommunityTitles();
            } catch (err) {
                console.error('Community sync error:', err);
            } finally {
                syncRunning = false;
            }
        };
        runCommunitySync();
        setInterval(runCommunitySync, commIntervalMs);
    }, commDelayMs);
    console.log(`Community sync scheduled every ${COMMUNITY_SYNC_INTERVAL_H}h (first run in ${COMMUNITY_SYNC_DELAY_H}h)`);

    // Sync profiles (delayed after startup, then on interval)
    const profDelayMs = PROFILE_SYNC_DELAY_H * 60 * 60 * 1000;
    const profIntervalMs = PROFILE_SYNC_INTERVAL_H * 60 * 60 * 1000;
    setTimeout(() => {
        const runProfileSync = async () => {
            syncRunning = true;
            console.log('Running profile sync...');
            try {
                await syncHiveProfiles();
            } catch (err) {
                console.error('Profile sync error:', err);
            } finally {
                syncRunning = false;
            }
        };
        runProfileSync();
        setInterval(runProfileSync, profIntervalMs);
    }, profDelayMs);
    console.log(`Profile sync scheduled every ${PROFILE_SYNC_INTERVAL_H}h (first run in ${PROFILE_SYNC_DELAY_H}h)`);

    // Sync audio → Hive post links (delayed 2min, then every 30min)
    setTimeout(() => {
        syncAudioHiveLinks().catch(err => console.error('Audio Hive sync error:', err));
        setInterval(() => {
            if (syncRunning) return;
            syncAudioHiveLinks().catch(err => console.error('Audio Hive sync error:', err));
        }, 30 * 60 * 1000);
    }, 2 * 60 * 1000);
    console.log('Audio-Hive link sync scheduled every 30min (first run in 2min)');

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
