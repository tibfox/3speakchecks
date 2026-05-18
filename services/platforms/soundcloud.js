// SoundCloud's official API (api.soundcloud.com) now requires an approved app
// (effectively gated behind a paid artist plan), so we don't use it. Instead we
// fetch the public, server-rendered profile page and read the `__sc_hydration`
// JSON blob the web app embeds — it carries the same user fields (permalink,
// username, full_name, city, description/bio) with no credentials needed.

const PROFILE_BASE = 'https://soundcloud.com';
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

// Pull the JSON array literal that follows `window.__sc_hydration =` out of the
// page HTML by walking it with a bracket-depth counter that respects strings
// and escapes (the blob is minified but can contain `]` inside strings).
function extractHydration(html) {
    const marker = '__sc_hydration';
    const at = html.indexOf(marker);
    if (at === -1) return null;
    const start = html.indexOf('[', at);
    if (start === -1) return null;

    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(html.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

// Resolve a SoundCloud profile to:
//   - canonical_username: the permalink slug (the only URL-addressable, and in
//     practice stable, identifier — SoundCloud has no public numeric-id URL,
//     so unlike YouTube's UC id we key dedup on the permalink)
//   - text: username + full name + city + bio joined with newlines
//
// Throws:
//   - err.code === 'CHANNEL_NOT_FOUND' if no such public profile
//   - generic Error on network/parse/block issues
async function fetchProfile(platformUsername) {
    const permalink = extractPermalink(platformUsername);
    if (!permalink) throw new Error('platform_username is required');

    const res = await fetch(`${PROFILE_BASE}/${encodeURIComponent(permalink)}`, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        redirect: 'follow',
    });
    if (res.status === 404) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[soundcloud] page error ${res.status}: ${body.slice(0, 300)}`);
        throw new Error('Platform lookup failed');
    }

    const html = await res.text();
    const hydration = extractHydration(html);
    const userEntry = Array.isArray(hydration)
        ? hydration.find((h) => h && h.hydratable === 'user' && h.data)
        : null;
    const user = userEntry && userEntry.data;

    if (!user || !user.permalink) {
        // Page loaded but carried no user object — unknown profile, a
        // non-user URL (track/playlist), or SoundCloud changed the markup.
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
