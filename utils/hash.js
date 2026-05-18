const crypto = require('crypto');

// Deterministic md5 of the lower-cased Hive username. Public — anyone can recompute it,
// but only the actual account owner can put it on their YouTube/etc. profile.
function hashForHiveUsername(hiveUsername) {
    const normalized = String(hiveUsername || '').trim().toLowerCase();
    if (!normalized) throw new Error('hive_username is required');
    return crypto.createHash('md5').update(normalized).digest('hex');
}

module.exports = { hashForHiveUsername };
