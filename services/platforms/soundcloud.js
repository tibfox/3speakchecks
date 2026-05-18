// SoundCloud's official API (api.soundcloud.com) now requires an approved app
// (effectively gated behind a paid artist plan). The server-rendered profile
// page does NOT include the bio/display-name (those load client-side), so
// scraping the page HTML can't see where users put a verification hash.
//
// Instead we use SoundCloud's public web API (api-v2.soundcloud.com) with a
// `client_id` lifted from the site's own JS bundle (no credentials, same
// thing the web app does). api-v2 returns the full user incl. `description`
// (bio), `full_name`, `city`.

const SITE_BASE = 'https://soundcloud.com';
const API_BASE = 'https://api-v2.soundcloud.com';
const UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Normalize whatever the user pastes (a bare slug, "@slug",
// "soundcloud.com/slug", or a full profile URL with query/hash) down to the
// canonical permalink slug.
function extractPermalink(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    s = s.replace(/^@/, '');
    const m = s.match(/soundcloud\.com\/([^/?#]+)/i);
    if (m) s = m[1];
    return s.split(/[/?#]/)[0].trim().toLowerCase();
}

// Cached client_id (SoundCloud rotates it; we re-derive on 401/403).
let cachedClientId = null;

async function deriveClientId() {
    const pageRes = await fetch(SITE_BASE, { headers: { 'User-Agent': UA } });
    if (!pageRes.ok) throw new Error('Platform lookup failed');
    const html = await pageRes.text();
    const bundles = [...html.matchAll(/<script[^>]+src="([^"]+sndcdn\.com[^"]+\.js)"/g)].map((m) => m[1]);
    // client_id lives in one of the later bundles.
    for (const url of bundles.reverse()) {
        // eslint-disable-next-line no-await-in-loop
        const js = await fetch(url, { headers: { 'User-Agent': UA } }).then((r) => r.text()).catch(() => '');
        const m = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{20,})"/);
        if (m) return m[1];
    }
    throw new Error('Platform lookup failed');
}

async function getClientId(forceRefresh) {
    if (cachedClientId && !forceRefresh) return cachedClientId;
    cachedClientId = await deriveClientId();
    return cachedClientId;
}

// Resolve a SoundCloud profile to:
//   - canonical_username: the permalink slug (SoundCloud has no public
//     numeric-id URL, so unlike YouTube's UC id we key dedup on the permalink)
//   - text: username + full name + city + bio joined with newlines
//
// Throws:
//   - err.code === 'CHANNEL_NOT_FOUND' if no such public user profile
//   - generic Error on network/parse/block issues
async function fetchProfile(platformUsername) {
    const permalink = extractPermalink(platformUsername);
    if (!permalink) throw new Error('platform_username is required');

    const profileUrl = `${SITE_BASE}/${encodeURIComponent(permalink)}`;

    async function resolveOnce(clientId) {
        return fetch(
            `${API_BASE}/resolve?url=${encodeURIComponent(profileUrl)}&client_id=${clientId}`,
            { headers: { 'User-Agent': UA, Accept: 'application/json' } },
        );
    }

    let clientId = await getClientId(false);
    let res = await resolveOnce(clientId);
    if (res.status === 401 || res.status === 403) {
        // client_id rotated — re-derive once and retry.
        clientId = await getClientId(true);
        res = await resolveOnce(clientId);
    }

    if (res.status === 404) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[soundcloud] api-v2 error ${res.status}: ${body.slice(0, 300)}`);
        throw new Error('Platform lookup failed');
    }

    let user;
    try {
        user = await res.json();
    } catch {
        throw new Error('Platform lookup failed');
    }

    // resolve also matches tracks/playlists — must be a user.
    if (!user || user.kind !== 'user' || !user.permalink) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }

    return {
        canonical_username: String(user.permalink).toLowerCase(),
        text: [user.username, user.full_name, user.city, user.description]
            .filter(Boolean)
            .join('\n'),
    };
}

module.exports = { name: 'soundcloud', fetchProfile };
