/**
 * Pulse hot set (#93): which watched videos make the list, and what the route
 * answers in each state. The aggregation itself runs on the Mongo server, so here
 * it is a fake that returns rows and records the pipeline it was given.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const config = require('../utils/config');
const { resolveHotSet, buildHotSet, _setHotSet } = require('../services/pulseHotSet');

const NOW = new Date('2026-11-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d) => new Date(NOW.getTime() - d * DAY);

// A fake db: find() honours the $or of { owner, permlink } the code builds, and
// aggregate() returns canned rows. Every call is recorded.
function fakeDb(collections, aggregateRows = []) {
  const calls = [];
  return {
    calls,
    collection: (name) => ({
      find: (query, options) => ({
        toArray: async () => {
          calls.push({ name, op: 'find', n: query.$or.length, maxTimeMS: options.maxTimeMS });
          const wanted = new Set(query.$or.map((c) => `${c.owner}/${c.permlink}`));
          return (collections[name] || []).filter((d) => wanted.has(`${d.owner}/${d.permlink}`));
        },
      }),
      aggregate: (pipeline, options) => ({
        toArray: async () => {
          calls.push({ name, op: 'aggregate', pipeline, options });
          return aggregateRows;
        },
      }),
    }),
  };
}

const row = (owner, permlink, sessions, lastWatchedAt = NOW) => ({ owner, permlink, sessions, lastWatchedAt });
const embed = (owner, permlink, extra = {}) => ({
  owner, permlink, hive_author: owner, status: 'published', createdAt: daysAgo(200), ...extra,
});
const legacy = (owner, permlink, extra = {}) => ({
  owner, permlink, status: 'published', created: daysAgo(400), ...extra,
});
const opts = (extra = {}) => ({ now: NOW, minAgeDays: 30, limit: 500, hiddenCreators: new Set(), ...extra });

describe('resolveHotSet', () => {
  test('resolves embeds first, then legacy videos, and labels the collection', async () => {
    const db = fakeDb({
      'embed-video': [embed('meno', 'abc')],
      videos: [legacy('tovia01', 'lkgdgnazjd')],
    });
    const { videos } = await resolveHotSet(db, [row('meno', 'abc', 41), row('tovia01', 'lkgdgnazjd', 9)], opts());
    expect(videos).toEqual([
      { collection: 'embed-video', owner: 'meno', permlink: 'abc', sessions: 41, lastWatchedAt: NOW },
      { collection: 'videos', owner: 'tovia01', permlink: 'lkgdgnazjd', sessions: 9, lastWatchedAt: NOW },
    ]);
    // Legacy is only asked about what the embed lookup didn't resolve.
    expect(db.calls.filter((c) => c.name === 'videos').map((c) => c.n)).toEqual([1]);
  });

  test('falls back to legacy when the embed is not published', async () => {
    const db = fakeDb({
      'embed-video': [embed('a', 'p', { status: 'encoding_ipfs' })],
      videos: [legacy('a', 'p')],
    });
    const { videos } = await resolveHotSet(db, [row('a', 'p', 7)], opts());
    expect(videos.map((v) => v.collection)).toEqual(['videos']);
  });

  test('drops unpublished, failed, banned and unavailable videos', async () => {
    const db = fakeDb({
      'embed-video': [embed('a', 'banned', { banned: true }), embed('a', 'gone', { unavailable: true })],
      videos: [legacy('b', 'draft', { status: 'uploaded' }), legacy('b', 'failed', { publishFailed: true })],
    });
    const rows = [row('a', 'banned', 9), row('a', 'gone', 9), row('b', 'draft', 9), row('b', 'failed', 9), row('c', 'missing', 9)];
    const { videos, skipped } = await resolveHotSet(db, rows, opts());
    expect(videos).toEqual([]);
    expect(skipped).toMatchObject({ unpublished: 3, banned: 1, unavailable: 1 });
  });

  test('drops HIDDEN_AUTHORS and moderation-hidden creators, by owner or hive_author', async () => {
    const hiddenAuthor = config.HIDDEN_AUTHORS[0];
    const db = fakeDb({
      'embed-video': [
        embed(hiddenAuthor, 'test'),
        embed('spammer', 'x'),
        embed('alias', 'y', { hive_author: 'Spammer' }),
        embed('fine', 'z'),
      ],
    });
    const rows = [row(hiddenAuthor, 'test', 9), row('spammer', 'x', 9), row('alias', 'y', 9), row('fine', 'z', 9)];
    const { videos, skipped } = await resolveHotSet(db, rows, opts({ hiddenCreators: new Set(['spammer']) }));
    expect(videos.map((v) => v.owner)).toEqual(['fine']);
    expect(skipped.hidden).toBe(3);
  });

  test('keeps hiddenFromFeed videos and shorts: the player still serves them', async () => {
    const db = fakeDb({
      'embed-video': [embed('a', 'unlisted', { hiddenFromFeed: true, listed_on_3speak: false }), embed('a', 'short', { short: true })],
    });
    const { videos } = await resolveHotSet(db, [row('a', 'unlisted', 9), row('a', 'short', 8)], opts());
    expect(videos.map((v) => v.permlink)).toEqual(['unlisted', 'short']);
  });

  test('skips videos younger than PULSE_HOTSET_MIN_AGE_DAYS, keeps undated legacy', async () => {
    const db = fakeDb({
      'embed-video': [embed('a', 'new', { createdAt: daysAgo(5) }), embed('a', 'edge', { createdAt: daysAgo(31) })],
      videos: [legacy('b', 'undated', { created: undefined })],
    });
    const { videos, skipped } = await resolveHotSet(db, [row('a', 'new', 99), row('a', 'edge', 9), row('b', 'undated', 9)], opts());
    expect(videos.map((v) => v.permlink)).toEqual(['edge', 'undated']);
    expect(skipped.young).toBe(1);
  });

  test('sorts by sessions, then most recently watched, and caps at the limit', async () => {
    const db = fakeDb({
      'embed-video': [embed('a', 'one'), embed('a', 'two'), embed('a', 'three'), embed('a', 'four')],
    });
    const rows = [
      row('a', 'one', 5),
      row('a', 'two', 20, daysAgo(1)),
      row('a', 'three', 20, NOW),
      row('a', 'four', 12),
    ];
    const { videos, skipped } = await resolveHotSet(db, rows, opts({ limit: 3 }));
    expect(videos.map((v) => v.permlink)).toEqual(['three', 'two', 'four']);
    expect(skipped.overLimit).toBe(1);
  });

  test('looks videos up in chunks', async () => {
    const docs = Array.from({ length: 450 }, (_, i) => embed('bulk', `v${i}`));
    const db = fakeDb({ 'embed-video': docs });
    const { videos } = await resolveHotSet(db, docs.map((d, i) => row(d.owner, d.permlink, i + 5)), opts({ limit: 1000 }));
    expect(videos).toHaveLength(450);
    expect(db.calls.filter((c) => c.name === 'embed-video').map((c) => c.n)).toEqual([200, 200, 50]);
  });
});

describe('buildHotSet', () => {
  test('aggregates the window with the junk-session filter and the threshold', async () => {
    const db = fakeDb({ 'embed-video': [embed('meno', 'abc')] }, [row('meno', 'abc', 41)]);
    const { body, stats } = await buildHotSet(db, {
      now: NOW, windowHours: 48, minSessions: 5, minAgeDays: 30, limit: 500, hiddenCreators: new Set(),
    });

    const agg = db.calls.find((c) => c.op === 'aggregate');
    expect(agg.name).toBe('view-durations');
    const [match, group, , threshold] = agg.pipeline;
    expect(match.$match.updatedAt.$gte).toEqual(new Date(NOW.getTime() - 48 * 60 * 60 * 1000));
    expect(match.$match.$expr.$gte[1]).toBe(config.RETENTION_MIN_SESSION_SECONDS);
    // Same counting key as retentionWorker.js: viewerId → ip → sid.
    expect(group.$group.keys).toEqual({ $addToSet: { $ifNull: ['$viewerId', { $ifNull: ['$ip', '$sid'] }] } });
    expect(threshold).toEqual({ $match: { sessions: { $gte: 5 } } });
    // A server-side cap on every query, so a stuck one can't hold the build forever.
    expect(agg.options.maxTimeMS).toBeGreaterThan(0);
    expect(db.calls.filter((c) => c.op === 'find').every((c) => c.maxTimeMS > 0)).toBe(true);

    expect(body).toEqual({
      generatedAt: NOW.toISOString(), windowHours: 48, minSessions: 5, count: 1,
      videos: [{ collection: 'embed-video', owner: 'meno', permlink: 'abc', sessions: 41, lastWatchedAt: NOW }],
    });
    expect(stats.watched).toBe(1);
  });

  test('builds an empty list when nothing qualifies, without touching the video collections', async () => {
    const db = fakeDb({}, []);
    const { body } = await buildHotSet(db, { now: NOW, hiddenCreators: new Set() });
    expect(body.count).toBe(0);
    expect(db.calls.filter((c) => c.op === 'find')).toEqual([]);
  });
});

describe('GET /pulse/hot-set', () => {
  const saved = {};
  const app = express();
  app.use('/pulse', require('../routes/pulse'));

  beforeEach(() => {
    saved.enabled = config.PULSE_HOTSET_ENABLED;
    saved.key = config.PULSE_API_KEY;
    config.PULSE_HOTSET_ENABLED = true;
    config.PULSE_API_KEY = 'pulse-key';
    _setHotSet(null);
  });
  afterEach(() => {
    config.PULSE_HOTSET_ENABLED = saved.enabled;
    config.PULSE_API_KEY = saved.key;
    _setHotSet(null);
  });

  const body = { generatedAt: NOW.toISOString(), windowHours: 48, minSessions: 5, count: 0, videos: [] };

  test('is off by default', () => {
    expect(saved.enabled).toBe(false);
  });

  test('404s when disabled, even with the right key', async () => {
    config.PULSE_HOTSET_ENABLED = false;
    _setHotSet(body);
    const res = await request(app).get('/pulse/hot-set').set('Authorization', 'Bearer pulse-key');
    expect(res.status).toBe(404);
  });

  test('401s without the Pulse key, including with API_SECRET_KEY', async () => {
    _setHotSet(body);
    const thumbnailKey = config.API_SECRET_KEY || 'your_secret_key_here_change_in_production';
    for (const auth of [undefined, 'Bearer wrong', `Bearer ${thumbnailKey}`, 'pulse-key', 'Basic pulse-key']) {
      const req = request(app).get('/pulse/hot-set');
      const res = await (auth ? req.set('Authorization', auth) : req);
      expect(res.status).toBe(401);
    }
  });

  test('401s everything when PULSE_API_KEY is unset', async () => {
    config.PULSE_API_KEY = '';
    _setHotSet(body);
    for (const auth of ['Bearer ', 'Bearer']) {
      const res = await request(app).get('/pulse/hot-set').set('Authorization', auth);
      expect(res.status).toBe(401);
    }
  });

  test('503s with Retry-After until the first build, never an empty list', async () => {
    const res = await request(app).get('/pulse/hot-set').set('Authorization', 'Bearer pulse-key');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('120');
    expect(res.body.videos).toBeUndefined();
  });

  test('serves the built list', async () => {
    const full = { ...body, count: 1, videos: [{ collection: 'videos', owner: 'a', permlink: 'b', sessions: 6, lastWatchedAt: NOW.toISOString() }] };
    _setHotSet(full);
    const res = await request(app).get('/pulse/hot-set').set('Authorization', 'Bearer pulse-key');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(full);
  });
});

describe('PULSE_HOTSET_* numbers', () => {
  const load = (env) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    let cfg;
    jest.isolateModules(() => { cfg = require('../utils/config'); });
    process.env = saved;
    return cfg;
  };

  test('keep a configured 0 where it means something', () => {
    expect(load({ PULSE_HOTSET_MIN_AGE_DAYS: '0' }).PULSE_HOTSET_MIN_AGE_DAYS).toBe(0);
  });

  test('fall back on negative, zero-where-meaningless, non-integer or junk values', () => {
    const cfg = load({
      PULSE_HOTSET_LIMIT: '-5',
      PULSE_HOTSET_MIN_SESSIONS: '0',
      PULSE_HOTSET_WINDOW_HOURS: '1.5',
      PULSE_HOTSET_INTERVAL_MIN: 'soon',
      PULSE_HOTSET_MIN_AGE_DAYS: '-1',
    });
    expect(cfg).toMatchObject({
      PULSE_HOTSET_LIMIT: 500, PULSE_HOTSET_MIN_SESSIONS: 5, PULSE_HOTSET_WINDOW_HOURS: 48,
      PULSE_HOTSET_INTERVAL_MIN: 30, PULSE_HOTSET_MIN_AGE_DAYS: 30,
    });
  });

  test('take valid values as given', () => {
    expect(load({ PULSE_HOTSET_LIMIT: '50', PULSE_HOTSET_WINDOW_HOURS: '24' })).toMatchObject({
      PULSE_HOTSET_LIMIT: 50, PULSE_HOTSET_WINDOW_HOURS: 24,
    });
  });
});

test('server.js mounts /pulse before the streamStats catch-all 401', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const pulse = src.indexOf("app.use('/pulse', require('./routes/pulse'))");
  const gate = src.indexOf("app.use('/', streamStatsRoutes)");
  expect(pulse).toBeGreaterThan(-1);
  expect(gate).toBeGreaterThan(pulse);
});
