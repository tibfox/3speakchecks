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

module.exports = { validateApiKey };
