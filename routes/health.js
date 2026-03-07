const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    res.json({
        message: 'Pancreas API is running',
        version: '1.3.0',
        endpoints: {
            check: '/check/:username',
            gethive: '/gethive/:user_id',
            getjobid: '/getjobid/:owner/:permlink',
            views: 'POST /views',
            myVideos: 'GET /api/my-videos?username={username}',
            videosByTag: 'GET /videos/tag/:tag?page={page}&limit={limit}',
            feed: 'GET /feed/:username?page={page}&limit={limit}',
            shorts: 'GET /shorts?page={page}&limit={limit}&app={frontend_app}',
            shortsSorted: 'GET /shortssorted?page={page}&limit={limit}&app={frontend_app}&seed={seed}&currentuser={username}',
            shortsStories: 'GET /shorts/stories?currentuser={username}&app={frontend_app}',
            updateThumbnail: 'PUT /video/thumbnail (Protected - requires API key)',
            feedRecommended: 'GET /feeds/recommended?page={page}&limit={limit}',
            feedNew: 'GET /feeds/new?page={page}&limit={limit}',
            feedTrending: 'GET /feeds/trending?page={page}&limit={limit}',
            feedFirstUploads: 'GET /feeds/firstUploads?page={page}&limit={limit}',
            search: 'GET /search?q={query}&page={page}&limit={limit}&type={video|short|audio|community|all}&nsfw={true|false}'
        }
    });
});

module.exports = router;
