const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { nsfwFilter } = require('../utils/filters');

router.get('/', async (req, res) => {
    try {
        const db = getDb();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        const skip = (page - 1) * limit;

        const audioCollection = db.collection('embed-audio');

        const audioQuery = {
            ...nsfwFilter(req)
        };

        const total = await audioCollection.countDocuments(audioQuery);
        const totalPages = Math.ceil(total / limit);

        const audio = await audioCollection
            .find(audioQuery)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

        res.json({
            page,
            limit,
            total,
            totalPages,
            audio
        });
    } catch (error) {
        console.error('Error fetching audio:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
