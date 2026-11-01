/**
 * GET /pulse/hot-set — the old videos people are watching, for Video Pulse.
 * See services/pulseHotSet.js and Mantequilla-Soft/3speakchecks#93.
 *
 *   404  PULSE_HOTSET_ENABLED is off
 *   401  wrong or missing PULSE_API_KEY
 *   503  the first build hasn't finished (never an empty list: Pulse would read
 *        that as "nothing is being watched")
 *   200  { generatedAt, windowHours, minSessions, count, videos: [
 *          { collection, owner, permlink, sessions, lastWatchedAt } ] }
 *
 * The list carries no CIDs or storage fields. Pulse reads each video from Mongo
 * itself, so nothing here has to be trusted.
 */
const express = require('express');
const { validatePulseKey } = require('../utils/middleware');
const { getHotSet } = require('../services/pulseHotSet');

const router = express.Router();

router.get('/hot-set', (req, res, next) => {
    // Read per request, so tests (and a config reload) see the current value.
    if (!require('../utils/config').PULSE_HOTSET_ENABLED) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    next();
}, validatePulseKey, (req, res) => {
    const body = getHotSet();
    res.set('Cache-Control', 'no-store');
    if (!body) {
        res.set('Retry-After', '120');
        return res.status(503).json({ success: false, error: 'Hot set not built yet' });
    }
    res.json(body);
});

module.exports = router;
