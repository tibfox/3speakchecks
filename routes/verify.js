const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { hashForHiveUsername } = require('../utils/hash');
const { getLinksCollection } = require('../utils/db');
const { verifyAndStore, unlinkIfRevoked } = require('../services/verifier');
const { listPlatforms } = require('../services/platforms');
const { requireHiveSignature } = require('../utils/hiveAuth');
const { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX } = require('../utils/config');

function shapeRecord(r) {
    if (!r) return null;
    return {
        hive_username: r.hive_username,
        platform: r.platform,
        platform_username: r.platform_username,
        hash: r.hash,
        verified: !!r.verified,
        verified_at: r.verified_at || null,
        last_checked: r.last_checked || null,
        first_seen: r.first_seen || null,
        last_error: r.last_error || null,
    };
}

const writeLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' },
});

// GET /verify/hash/:hive_username — getUserHash (public, no auth — hash is public by design)
router.get('/hash/:hive_username', (req, res) => {
    try {
        const hive_username = req.params.hive_username;
        const hash = hashForHiveUsername(hive_username);
        res.json({ hive_username: hive_username.toLowerCase(), hash });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /verify/check?hive_username&platform&platform_username&timestamp&signature — checkUserHash
router.get('/check', writeLimiter, requireHiveSignature('check'), async (req, res) => {
    const { hive_username, platform, platform_username } = req.query;
    if (!hive_username || !platform || !platform_username) {
        return res.status(400).json({
            error: 'hive_username, platform, and platform_username are required',
        });
    }
    try {
        const saved = await verifyAndStore({
            hive_username: String(hive_username),
            platform: String(platform),
            platform_username: String(platform_username),
        });
        res.json(shapeRecord(saved));
    } catch (err) {
        if (err.code === 'UNSUPPORTED_PLATFORM') {
            return res.status(400).json({ error: err.message, supported: listPlatforms() });
        }
        if (err.code === 'CHANNEL_NOT_FOUND') {
            return res.status(404).json({ error: err.message });
        }
        if (err.code === 'CHANNEL_ALREADY_LINKED') {
            return res.status(409).json({ error: err.message, claimed_by: err.claimedBy });
        }
        if (err.code === 'TOO_MANY_LINKS') {
            return res.status(409).json({ error: err.message });
        }
        console.error('verify/check failed:', err);
        res.status(502).json({ error: 'Platform lookup failed.' });
    }
});

// GET /verify/unlink?hive_username&platform&platform_username&timestamp&signature
// Rescans the platform; deletes the stored record only if the hash is no longer
// present. Otherwise the row is kept (user must remove the hash from their profile first).
router.get('/unlink', writeLimiter, requireHiveSignature('unlink'), async (req, res) => {
    const { hive_username, platform, platform_username } = req.query;
    if (!hive_username || !platform || !platform_username) {
        return res.status(400).json({
            error: 'hive_username, platform, and platform_username are required',
        });
    }
    try {
        const result = await unlinkIfRevoked({
            hive_username: String(hive_username),
            platform: String(platform),
            platform_username: String(platform_username),
        });
        switch (result.status) {
            case 'deleted':
                return res.json({ deleted: true, record: shapeRecord(result.record) });
            case 'still_present':
                return res.status(409).json({
                    deleted: false,
                    still_present: true,
                    message: 'Hash is still on the public profile. Remove it from the profile, then call unlink again.',
                    record: shapeRecord(result.record),
                });
            case 'not_found':
                return res.status(404).json({ deleted: false, error: 'No stored link for that triplet' });
            case 'lookup_failed':
                console.error('verify/unlink lookup_failed:', result.error);
                return res.status(502).json({ deleted: false, error: 'Platform lookup failed.' });
            default:
                return res.status(500).json({ deleted: false, error: 'Unknown status' });
        }
    } catch (err) {
        if (err.code === 'UNSUPPORTED_PLATFORM') {
            return res.status(400).json({ error: err.message, supported: listPlatforms() });
        }
        console.error('verify/unlink failed:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// GET /verify/links/:hive_username?include_pending=true — getUserLinks (public read)
router.get('/links/:hive_username', async (req, res) => {
    try {
        const hive_username = String(req.params.hive_username || '').trim().toLowerCase();
        if (!hive_username) {
            return res.status(400).json({ error: 'hive_username is required' });
        }
        const includePending = req.query.include_pending === 'true';
        const filter = { hive_username };
        if (!includePending) filter.verified = true;

        const docs = await getLinksCollection()
            .find(filter)
            .sort({ verified: -1, last_checked: -1 })
            .toArray();

        res.json({
            hive_username,
            links: docs.map(shapeRecord),
        });
    } catch (err) {
        console.error('verify/links failed:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /verify/platforms — list supported platforms
router.get('/platforms', (_req, res) => {
    res.json({ platforms: listPlatforms() });
});

module.exports = router;
