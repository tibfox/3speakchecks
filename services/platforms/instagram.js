// ⚠️ NOT REGISTERED in platforms/index.js. Tested 2026-10-04: web_profile_info
// answers 401 "require_login" / 429 for every exit IP tried (datacenter and ~13
// DataImpulse residential IPs, also with the browser's own cookies + CSRF token).
// The only thing that worked was posing as the Instagram Android app, which we
// do not do. The proper route is Meta's "Instagram API with Instagram Login".
//
// Instagram profile lookup for the bio-hash verification.
//
// The public profile (what instagram.com shows a logged-out visitor) comes from
// the same endpoint the web app itself calls, web_profile_info, which returns
// username, full_name and biography. Instagram answers it for home internet
// connections but refuses datacenter IPs ("require_login", HTTP 401), so it goes
// through a residential proxy, retrying from a different exit IP when refused.
//
// The proxy URL lives in .env.social.local (git-ignored by `.env.*.local`) as
// SOCIAL_FETCH_PROXY, kept out of the main .env on purpose. It may carry the same
// placeholders as the importer's YTDLP_PROXY: {port:A-B} (random port, for
// port-pinned sticky sessions like DataImpulse) or {session} (random id).
//
// Canonical id = the lower-cased username: that is what profile URLs and every
// video's yt-dlp `channel` field use, so the import owner check compares it.

const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.social.local'), quiet: true });

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
// The public id of Instagram's own web client, sent by instagram.com itself.
const WEB_APP_ID = '936619743392459';
const MAX_ATTEMPTS = Number(process.env.SOCIAL_FETCH_ATTEMPTS) || 5;

function proxyUrl() {
    const tpl = process.env.SOCIAL_FETCH_PROXY || '';
    if (!tpl) return '';
    return tpl
        .replace(/\{session\}/g, crypto.randomBytes(6).toString('hex'))
        .replace(/\{port:(\d+)-(\d+)\}/g, (_, a, b) => String(Number(a) + crypto.randomInt(Number(b) - Number(a) + 1)));
}

// "@name", "name", "instagram.com/name", a profile URL.
function extractUsername(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    const m = s.match(/instagram\.com\/([^/?#]+)/i);
    if (m) s = m[1];
    s = s.replace(/^@/, '').split(/[/?#\s]/)[0];
    if (['p', 'reel', 'reels', 'tv', 'stories', 'explore'].includes(s.toLowerCase())) return '';
    return /^[A-Za-z0-9_.]{1,30}$/.test(s) ? s.toLowerCase() : '';
}

function getJson(url, agent) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            agent,
            headers: { 'User-Agent': UA, 'x-ig-app-id': WEB_APP_ID, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
            timeout: 15000,
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(new Error('too large')); });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(body); } catch { /* not json */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

async function fetchProfile(platformUsername) {
    const username = extractUsername(platformUsername);
    if (!username) {
        const err = new Error('Channel not found');
        err.code = 'CHANNEL_NOT_FOUND';
        throw err;
    }
    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

    const attempts = process.env.SOCIAL_FETCH_PROXY ? MAX_ATTEMPTS : 1;
    for (let i = 1; i <= attempts; i++) {
        const px = proxyUrl();
        let r;
        try {
            // eslint-disable-next-line no-await-in-loop
            r = await getJson(url, px ? new HttpsProxyAgent(px) : undefined);
        } catch (e) {
            console.warn(`[instagram] attempt ${i} for @${username} failed: ${String(e.message).replace(/\/\/[^\s/@]+@/g, '//***@')}`);
            continue;
        }
        if (r.status === 404 || (r.status === 200 && r.json && !r.json?.data?.user)) {
            const err = new Error('Channel not found');
            err.code = 'CHANNEL_NOT_FOUND';
            throw err;
        }
        const user = r.json?.data?.user;
        if (r.status === 200 && user) {
            return {
                canonical_username: String(user.username).toLowerCase(),
                text: [user.username, user.full_name, user.biography].filter(Boolean).join('\n'),
            };
        }
        // 401 require_login / 429: this exit IP is not welcome, try another.
        console.warn(`[instagram] attempt ${i} for @${username}: HTTP ${r.status}`);
    }
    throw new Error('Platform lookup failed');
}

module.exports = { name: 'instagram', fetchProfile, extractUsername };
