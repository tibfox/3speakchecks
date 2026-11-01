const crypto = require('crypto');
const { API_SECRET_KEY } = require('./config');

/**
 * Middleware to validate API key for protected endpoints
 * Expects API key in Authorization header: 'Bearer YOUR_API_KEY'
 */
function validateApiKey(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
            message: 'Missing Authorization header'
        });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
            message: 'Invalid authorization format. Use: Bearer YOUR_API_KEY'
        });
    }

    const providedKey = parts[1];

    if (providedKey !== API_SECRET_KEY) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
            message: 'Invalid API key'
        });
    }

    next();
}

/**
 * Middleware for GET /pulse/hot-set: same Bearer format, but checked against
 * PULSE_API_KEY, so Video Pulse never holds API_SECRET_KEY (which also guards
 * thumbnail writes). Kept separate so validateApiKey's callers are untouched.
 * An unset PULSE_API_KEY rejects everything rather than matching an empty token.
 */
function validatePulseKey(req, res, next) {
    const { PULSE_API_KEY } = require('./config');
    const authHeader = req.headers['authorization'] || '';
    const parts = authHeader.split(' ');
    const provided = parts.length === 2 && parts[0] === 'Bearer' ? parts[1] : '';

    const a = Buffer.from(provided);
    const b = Buffer.from(PULSE_API_KEY || '');
    if (!PULSE_API_KEY || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
            message: 'Invalid or missing Pulse API key'
        });
    }

    next();
}

module.exports = { validateApiKey, validatePulseKey };
