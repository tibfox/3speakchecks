const dhive = require('@hiveio/dhive');
const {
    HIVE_AUTH_REQUIRED,
    HIVE_RPC_ENDPOINTS,
    SIGNATURE_TIMESTAMP_TOLERANCE_MS,
} = require('./config');

const client = new dhive.Client(HIVE_RPC_ENDPOINTS);

// 60s in-memory cache of (username -> posting public-key strings).
// Hive accounts rarely rotate keys, but a short TTL keeps us correct
// without hammering the RPCs on every request.
const KEY_CACHE_TTL_MS = 60 * 1000;
const keyCache = new Map();

async function getPostingPublicKeys(username) {
    const cached = keyCache.get(username);
    if (cached && Date.now() - cached.t < KEY_CACHE_TTL_MS) {
        return cached.keys;
    }
    const accounts = await client.database.getAccounts([username]);
    const account = accounts && accounts[0];
    if (!account) {
        const err = new Error('Hive account not found');
        err.code = 'HIVE_ACCOUNT_NOT_FOUND';
        throw err;
    }
    const keys = (account.posting && account.posting.key_auths || []).map(([k]) => k);
    keyCache.set(username, { keys, t: Date.now() });
    return keys;
}

// Recover the signing key from the signature, then check it's listed in the
// account's posting authorities. Recovery is single-shot — much cheaper than
// trying every authorized key with PublicKey.verify.
async function verifyHiveSignedMessage({ message, signature, username }) {
    const sig = dhive.Signature.fromString(signature);
    const messageHash = dhive.cryptoUtils.sha256(Buffer.from(message, 'utf8'));
    const recovered = sig.recover(messageHash).toString();
    const authorized = await getPostingPublicKeys(username);
    return authorized.includes(recovered);
}

// Build the canonical message-to-sign for a request. Bound to the action,
// the hive_username, the specific link triplet, and a timestamp so a captured
// signature can't be replayed for a different action/user/channel/time.
function buildMessage({ action, hive_username, platform, platform_username, timestamp }) {
    return [
        '3speak-social-verifier',
        action,
        String(hive_username || '').toLowerCase(),
        String(platform || ''),
        String(platform_username || ''),
        String(timestamp),
    ].join('|');
}

// Express middleware factory. `action` is "check" or "unlink" — used in
// the signed message so a check-signature can't be replayed against unlink.
function requireHiveSignature(action) {
    return async function (req, res, next) {
        if (!HIVE_AUTH_REQUIRED) return next();

        const hive_username = String(req.query.hive_username || '').trim();
        const platform = String(req.query.platform || '').trim();
        const platform_username = String(req.query.platform_username || '').trim();
        const signature = String(req.query.signature || req.headers['x-hive-signature'] || '').trim();
        const tsRaw = String(req.query.timestamp || req.headers['x-hive-timestamp'] || '').trim();

        if (!hive_username || !platform || !platform_username) {
            return res.status(400).json({ error: 'hive_username, platform, and platform_username are required' });
        }
        if (!signature || !tsRaw) {
            return res.status(401).json({
                error: 'Missing signature or timestamp',
                expected_message: buildMessage({ action, hive_username, platform, platform_username, timestamp: '<ms>' }),
            });
        }

        const timestamp = parseInt(tsRaw, 10);
        if (!Number.isFinite(timestamp)) {
            return res.status(401).json({ error: 'Invalid timestamp' });
        }
        if (Math.abs(Date.now() - timestamp) > SIGNATURE_TIMESTAMP_TOLERANCE_MS) {
            return res.status(401).json({ error: 'Timestamp out of tolerance window' });
        }

        const message = buildMessage({ action, hive_username, platform, platform_username, timestamp });
        try {
            const ok = await verifyHiveSignedMessage({ message, signature, username: hive_username });
            if (!ok) return res.status(401).json({ error: 'Invalid signature' });
            return next();
        } catch (err) {
            if (err.code === 'HIVE_ACCOUNT_NOT_FOUND') {
                return res.status(404).json({ error: 'Hive account not found' });
            }
            // Most other errors here are signature parse errors (malformed hex,
            // wrong length, etc.) — treat as bad input, not a server fault.
            console.error('hive auth signature parse/recover error:', err.message || err);
            return res.status(401).json({ error: 'Invalid signature' });
        }
    };
}

module.exports = { requireHiveSignature, buildMessage, verifyHiveSignedMessage };
