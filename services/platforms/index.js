const youtube = require('./youtube');
const soundcloud = require('./soundcloud');
const tiktok = require('./tiktok');
// instagram.js is NOT registered: Instagram refuses public profile reads from
// servers (401/429 even via residential IPs, tested 2026-10-04). See its header.

const platforms = {
    [youtube.name]: youtube,
    [soundcloud.name]: soundcloud,
    [tiktok.name]: tiktok,
};

function getPlatform(name) {
    const key = String(name || '').trim().toLowerCase();
    return platforms[key] || null;
}

function listPlatforms() {
    return Object.keys(platforms);
}

module.exports = { getPlatform, listPlatforms };
