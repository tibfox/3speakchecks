const youtube = require('./youtube');
const soundcloud = require('./soundcloud');

const platforms = {
    [youtube.name]: youtube,
    [soundcloud.name]: soundcloud,
};

function getPlatform(name) {
    const key = String(name || '').trim().toLowerCase();
    return platforms[key] || null;
}

function listPlatforms() {
    return Object.keys(platforms);
}

module.exports = { getPlatform, listPlatforms };
