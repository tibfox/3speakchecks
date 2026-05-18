const { YOUTUBE_API_KEY } = require('../../utils/config');

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

// Resolve a YouTube identifier (handle like "@name" or channel ID like "UC...")
// to:
//   - canonical_username: the immutable UC... channel ID (used as DB storage key)
//   - text: title + description joined with a newline (the searchable surface)
//
// Throws:
//   - err.code === 'CHANNEL_NOT_FOUND' if the API returned no items
//   - generic Error on quota/network/auth issues (includes the API status)
async function fetchProfile(platformUsername) {
    if (!YOUTUBE_API_KEY) {
        throw new Error('YOUTUBE_API_KEY is not configured');
    }
    const raw = String(platformUsername || '').trim();
    if (!raw) throw new Error('platform_username is required');

    const url = new URL('https://www.googleapis.com/youtube/v3/channels');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('key', YOUTUBE_API_KEY);

    if (CHANNEL_ID_RE.test(raw)) {
        url.searchParams.set('id', raw);
    } else {
        url.searchParams.set('forHandle', raw.replace(/^@/, ''));
    }

    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Log details server-side; surface only a generic message to callers
        // so quota/auth issues aren't leaked.
        console.error(`[youtube] API error ${res.status}: ${body.slice(0, 500)}`);
        throw new Error('Platform lookup failed');
    }
    const data = await res.json();
    const item = data.items && data.items[0];
    if (!item) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }
    const snippet = item.snippet || {};
    return {
        canonical_username: item.id,
        text: [snippet.title, snippet.description].filter(Boolean).join('\n'),
    };
}

module.exports = { name: 'youtube', fetchProfile };
