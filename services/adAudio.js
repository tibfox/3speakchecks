/**
 * 🔊 Making a spot's audio match the video it is spliced into.
 *
 * WHY THIS EXISTS
 * A stitched playlist puts the ad behind an EXT-X-DISCONTINUITY and both go into the
 * same MSE SourceBuffer. Chrome refuses an audio SAMPLE RATE change mid-buffer;
 * Firefox tolerates it. When the append fails, the player's gap handling jumps the
 * playhead past the hole — so on Chrome the spot silently did not play at all, while
 * the same session on Firefox was fine.
 *
 * 🚨 There is no single rate to encode ads at. The library is mixed: measured across
 * recent uploads, some videos are 44100 and some 48000, and every ad creative we have
 * is 44100. So the ad has to match whatever video it lands in front of, which is a
 * decision per (creative, content) and cannot be made once at upload.
 *
 * WHAT IT DOES
 * Probes both sides, and when they differ, re-encodes the ad's segments to the
 * content's rate. Audio only: the video stream is copied through, so this is cheap and
 * leaves the picture bit-identical. The result is cached on disk by segment and rate,
 * so a creative is transcoded at most once per rate it meets — two files, ever.
 *
 * Everything here fails SOFT. A probe that does not answer, or a transcode that does
 * not finish, leaves the ad exactly as it was: the spot may not render on Chrome, but
 * the viewer's video is untouched, which is the trade this whole path is built on.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const {
  AD_BURN_CACHE_DIR, AD_BURN_TIMEOUT_MS, AD_AUDIO_NORMALISE,
} = require('../utils/config');
const { getDb } = require('../utils/db');

const CACHE_DIR = AD_BURN_CACHE_DIR || path.join(os.tmpdir(), '3speak-ad-burn');
const PROBES = 'ad_media_probe';

// Probing costs a round trip to the CDN, so the answer is kept both in this process
// and in Mongo — the second because a restart should not re-probe the whole library.
const memo = new Map();

const keyOf = (url) => crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);

async function ensureDir() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
}

/**
 * The audio sample rate of a manifest or segment, or null when it cannot be read.
 *
 * ffprobe is pointed at the URL directly rather than at bytes fetched here: it reads
 * a master playlist, picks a variant and stops once it has the stream header, which
 * is far less than downloading a segment to inspect it.
 */
async function audioRateOf(url) {
  if (!url) return null;
  if (memo.has(url)) return memo.get(url);

  const key = keyOf(url);
  try {
    const hit = await getDb().collection(PROBES).findOne({ _id: key });
    if (hit && typeof hit.rate !== 'undefined') {
      memo.set(url, hit.rate);
      return hit.rate;
    }
  } catch (_) { /* the probe below is the fallback */ }

  let rate = null;
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate',
      '-of', 'default=nw=1:nk=1',
      url,
    ], { timeout: AD_BURN_TIMEOUT_MS || 30000, maxBuffer: 1 << 20 });
    const n = parseInt(String(stdout).trim(), 10);
    rate = Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    rate = null;
  }

  memo.set(url, rate);
  // Cached even when null: a creative with no audio track, or a URL ffprobe cannot
  // read, should not be re-probed on every playback.
  getDb().collection(PROBES)
    .updateOne({ _id: key }, { $set: { url, rate, at: new Date() } }, { upsert: true })
    .catch(() => { /* the in-process memo still holds it */ });
  return rate;
}

/** The cached answer only. Null when nothing has probed this yet. */
function knownRate(url) {
  return memo.has(url) ? memo.get(url) : undefined;
}

/** Probe without making anyone wait for it. */
function warmRate(url) {
  if (!url || memo.has(url)) return;
  audioRateOf(url).catch(() => { /* it will be tried again next time */ });
}

/**
 * A copy of one ad segment with its audio resampled, or null if that was not possible.
 *
 * `-c:v copy` is the point: the picture is passed through untouched, so the work is a
 * few hundred milliseconds of audio encoding rather than a video transcode, and the
 * segment's duration and frame timing cannot drift as a result of this.
 */
async function normalisedSegment(segmentUrl, targetRate) {
  if (!AD_AUDIO_NORMALISE || !segmentUrl || !(targetRate > 0)) return null;
  await ensureDir();

  const key = `aud-${keyOf(segmentUrl)}-${targetRate}`;
  const out = path.join(CACHE_DIR, `${key}.ts`);
  try {
    const st = await fsp.stat(out);
    if (st.size > 0) return out;
  } catch (_) { /* not cached yet */ }

  const tmp = path.join(CACHE_DIR, `.${key}.tmp.ts`);
  try {
    await execFileP('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', segmentUrl,
      '-c:v', 'copy',
      '-c:a', 'aac', '-ar', String(targetRate), '-ac', '2', '-b:a', '128k',
      // Keep the original timestamps. The stitched playlist declares this segment's
      // length from the creative's own manifest, and a remux that re-based the clock
      // would put the declared and real durations even further apart than they are.
      '-copyts', '-muxdelay', '0', '-muxpreload', '0',
      '-f', 'mpegts', tmp,
    ], { timeout: AD_BURN_TIMEOUT_MS || 30000, maxBuffer: 1 << 20 });

    const st = await fsp.stat(tmp);
    if (!st.size) throw new Error('ffmpeg produced nothing');
    await fsp.rename(tmp, out);
    return out;
  } catch (err) {
    console.error('[ad-audio] normalise failed:', err && err.message);
    await fsp.unlink(tmp).catch(() => {});
    return null;
  }
}

module.exports = { audioRateOf, knownRate, warmRate, normalisedSegment };
