/**
 * Pulse hot set: the old videos people are watching right now.
 *
 * Video Pulse (Mantequilla-Soft/videopulse) restores archived videos to a hotnode
 * when they are being watched again. Instead of the player pinging Pulse on every
 * play, Pulse reads this list once an hour from GET /pulse/hot-set
 * (Mantequilla-Soft/3speakchecks#93). Pancreas only says what is being watched;
 * Pulse works out which of those are not on a hotnode.
 *
 * READ-ONLY. One aggregation over the last PULSE_HOTSET_WINDOW_HOURS of
 * view-durations, then chunked lookups of the matching video docs. Nothing is
 * written anywhere. For scale: the retention worker already aggregates 90 days of
 * the same collection every 5 minutes; this is 48 hours every 30.
 *
 * The list lives in memory. Until the first build succeeds getHotSet() returns
 * null and the route answers 503, never an empty list: Pulse would read an empty
 * list as "nothing is being watched". A failed rebuild keeps the previous list.
 *
 * Off unless PULSE_HOTSET_ENABLED=true.
 */
const { getDb } = require('../utils/db');
const { getHiddenSet } = require('../utils/hiddenCreators');
const {
  PULSE_HOTSET_ENABLED, PULSE_HOTSET_WINDOW_HOURS, PULSE_HOTSET_MIN_SESSIONS,
  PULSE_HOTSET_MIN_AGE_DAYS, PULSE_HOTSET_LIMIT, PULSE_HOTSET_INTERVAL_MIN,
  RETENTION_MIN_SESSION_SECONDS, HIDDEN_AUTHORS,
} = require('../utils/config');

const WATCH_LOG = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const HIDDEN_SET = new Set(HIDDEN_AUTHORS.map((a) => String(a).trim().toLowerCase()));
const isHiddenAuthor = (name) => !!name && HIDDEN_SET.has(String(name).trim().toLowerCase());

/**
 * Per-video watch counts over the window, on the Mongo server. Same junk-session
 * filter and counting key as services/retentionWorker.js, so the numbers match the
 * rest of Pancreas. Since the GDPR sweep (2026-07-15) only `sid` is left, so these
 * are SESSION counts: a viewer who replays counts twice.
 */
function watchedPipeline({ cutoff, minSessions }) {
  return [
    { $match: {
      updatedAt: { $gte: cutoff },
      $expr: { $gte: [{ $ifNull: ['$contentSeconds', { $ifNull: ['$watchedSeconds', 0] }] }, RETENTION_MIN_SESSION_SECONDS] },
    } },
    { $group: {
      _id: { owner: '$owner', permlink: '$permlink' },
      keys: { $addToSet: { $ifNull: ['$viewerId', { $ifNull: ['$ip', '$sid'] }] } },
      lastWatchedAt: { $max: '$updatedAt' },
    } },
    { $project: { _id: 0, owner: '$_id.owner', permlink: '$_id.permlink', sessions: { $size: '$keys' }, lastWatchedAt: 1 } },
    { $match: { sessions: { $gte: minSessions } } },
  ];
}

async function aggregateWatched(db, opts) {
  return db.collection(WATCH_LOG).aggregate(watchedPipeline(opts), { allowDiskUse: true }).toArray();
}

/** $or lookups in chunks, like services/discoverWorker.js. */
async function findChunked(coll, conds, projection, size = 200) {
  const out = [];
  for (let i = 0; i < conds.length; i += size) {
    out.push(...await coll.find({ $or: conds.slice(i, i + size) }, { projection }).toArray());
  }
  return out;
}

/**
 * Turn watched owner/permlink keys into the published videos they belong to, the
 * way services/discoverWorker.js step 2 does: embed-video first, then legacy
 * `videos`, then the moderation filters. Returns the list Pulse reads.
 *
 * Deliberately NOT filtered on `hiddenFromFeed` or `listed_on_3speak`: those only
 * keep a video out of feeds, the player still serves it, and it still costs the
 * same to deliver when people watch it. Shorts are included for the same reason.
 */
async function resolveHotSet(db, rows, { now, minAgeDays, limit, hiddenCreators }) {
  const ageCutoff = new Date(now - minAgeDays * DAY_MS);
  const conds = rows.map((r) => ({ owner: r.owner, permlink: r.permlink }));

  const embeds = await findChunked(db.collection('embed-video'), conds, {
    owner: 1, permlink: 1, hive_author: 1, status: 1, createdAt: 1, banned: 1, unavailable: 1,
  });
  const embedByKey = new Map(embeds
    .filter((d) => d.status === 'published')
    .map((d) => [`${d.owner}/${d.permlink}`, d]));

  // Anything not resolvable as a published embed → look it up in legacy `videos`.
  const legacyConds = conds.filter((c) => !embedByKey.has(`${c.owner}/${c.permlink}`));
  const legacy = legacyConds.length ? await findChunked(db.collection('videos'), legacyConds, {
    owner: 1, permlink: 1, status: 1, publishFailed: 1, created: 1, banned: 1, unavailable: 1,
  }) : [];
  const legacyByKey = new Map(legacy
    .filter((d) => d.status === 'published' && d.publishFailed !== true)
    .map((d) => [`${d.owner}/${d.permlink}`, d]));

  const isHiddenCreator = (name) => !!name && hiddenCreators.has(String(name).toLowerCase());
  const skipped = { unpublished: 0, banned: 0, unavailable: 0, hidden: 0, young: 0 };
  const videos = [];
  for (const r of rows) {
    const key = `${r.owner}/${r.permlink}`;
    const ev = embedByKey.get(key);
    const lv = ev ? null : legacyByKey.get(key);
    const doc = ev || lv;
    if (!doc) { skipped.unpublished++; continue; }
    if (doc.banned === true) { skipped.banned++; continue; }
    // Confirmed gone on every gateway (utils/unavailable.js). Nothing to restore.
    if (doc.unavailable === true) { skipped.unavailable++; continue; }
    // An embed's hive_author can differ from its owner, so check both.
    if (isHiddenAuthor(r.owner) || isHiddenCreator(r.owner)
        || (ev && (isHiddenAuthor(ev.hive_author) || isHiddenCreator(ev.hive_author)))) {
      skipped.hidden++; continue;
    }
    // Young videos are still on a hotnode; listing them only makes the list longer.
    // Undated legacy docs are old ones, so they stay in.
    const created = ev ? ev.createdAt : lv.created;
    if (created && new Date(created) > ageCutoff) { skipped.young++; continue; }

    videos.push({
      collection: ev ? 'embed-video' : 'videos',
      owner: r.owner,
      permlink: r.permlink,
      sessions: r.sessions,
      lastWatchedAt: r.lastWatchedAt,
    });
  }

  videos.sort((a, b) => (b.sessions - a.sessions)
    || (new Date(b.lastWatchedAt) - new Date(a.lastWatchedAt)));
  const capped = videos.length - Math.min(videos.length, limit);
  return { videos: videos.slice(0, limit), skipped: { ...skipped, overLimit: capped } };
}

/** Build the whole response body. Exported for tests and scripts/pulse-hot-set-timing.js. */
async function buildHotSet(db, {
  now = new Date(),
  windowHours = PULSE_HOTSET_WINDOW_HOURS,
  minSessions = PULSE_HOTSET_MIN_SESSIONS,
  minAgeDays = PULSE_HOTSET_MIN_AGE_DAYS,
  limit = PULSE_HOTSET_LIMIT,
  hiddenCreators,
} = {}) {
  const cutoff = new Date(now - windowHours * HOUR_MS);
  const rows = await aggregateWatched(db, { cutoff, minSessions });
  const hidden = hiddenCreators || await getHiddenSet(db);
  const { videos, skipped } = await resolveHotSet(db, rows, { now, minAgeDays, limit, hiddenCreators: hidden });
  return {
    body: {
      generatedAt: now.toISOString(),
      windowHours,
      minSessions,
      count: videos.length,
      videos,
    },
    stats: { watched: rows.length, skipped },
  };
}

// ── in-memory copy + schedule ───────────────────────────────────────────────
let current = null;   // the last successful body, or null until one succeeds
let running = false;

/** The latest list, or null while the first build hasn't finished. */
function getHotSet() {
  return current;
}

async function refreshOnce() {
  if (running) {
    console.log('[pulse-hot-set] previous build still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const { body, stats } = await buildHotSet(getDb());
    current = body;
    console.log(`[pulse-hot-set] ${body.count} videos from ${stats.watched} watched in ${Date.now() - startedAt}ms`
      + ` (skipped ${JSON.stringify(stats.skipped)})`);
  } catch (err) {
    // Keep serving the previous list; a cold failure stays null → 503.
    console.error('[pulse-hot-set] build failed, keeping the previous list:', err && err.message);
  } finally {
    running = false;
  }
}

function schedulePulseHotSet() {
  if (!PULSE_HOTSET_ENABLED) {
    console.log('[pulse-hot-set] disabled (PULSE_HOTSET_ENABLED=false)');
    return;
  }
  // First build a minute after boot (let the process settle), then on the interval.
  setTimeout(refreshOnce, 60 * 1000);
  setInterval(refreshOnce, Math.max(1, PULSE_HOTSET_INTERVAL_MIN) * 60 * 1000);
  console.log(`[pulse-hot-set] scheduled every ${PULSE_HOTSET_INTERVAL_MIN} min, first build in 1 min`);
}

/** Test hook. */
function _setHotSet(body) {
  current = body;
}

module.exports = { buildHotSet, resolveHotSet, aggregateWatched, watchedPipeline, WATCH_LOG, getHotSet, schedulePulseHotSet, refreshOnce, _setHotSet };
