/**
 * Ticker ads, SPOKEN: every ticker message is also rendered to a short MP3 that the
 * 3speak.tv audio player plays as an audio spot (routes/adServe.js, surface 'audio').
 *
 *   [chime] "Sponsored message from <product>. <their message>. Click the link in the
 *   player to find out more."   (the last sentence only with a link; calm music under it)
 *
 * Text to speech runs on this box with Piper (offline, CPU only, no API key, nothing
 * about the advertiser or the listener leaves the machine). One file per spoken
 * text, named by its hash, so an unchanged message is never rendered twice and a
 * new product name or message gets a new file on the next sweep.
 *
 * NOTHING HERE DECIDES WHETHER A SPOT SERVES. The approval gate, payment, flight
 * window and frequency cap are the ticker's own, checked in adServe exactly as for
 * the video strip. This only makes the sound exist. A message is rendered while it
 * still waits for review, so the reviewer can listen to it before approving.
 *
 * Gates (all env, read at boot):
 *   AD_AUDIO_TICKER_ENABLED         master switch for serving, default true
 *   AD_AUDIO_TICKER_ALLOWED_OWNERS  whose AUDIO may carry one. DEFAULT 'badadib'.
 *                                   Same contract as every other owner list here:
 *                                   set and EMPTY means every creator.
 *   AD_TTS_PIPER_BIN / AD_TTS_VOICE the engine and the voice. If either is missing
 *                                   the renderer stays idle and no audio spot serves.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const config = require('./config');

const { AD_CREATIVES_COLLECTION, ADVERTISERS_COLLECTION, ENABLE_MONGO_WRITES } = config;

const parseBool = (v, fallback) => {
  if (v === undefined || v === null || v === '') return fallback;
  return String(v).toLowerCase() === 'true';
};

const TOOLS = '/mnt/HC_Volume_103240961/prodops/tools/piper';
const PIPER_BIN = process.env.AD_TTS_PIPER_BIN || path.join(TOOLS, 'piper');
const VOICE = process.env.AD_TTS_VOICE || path.join(TOOLS, 'voices', 'en_GB-alan-medium.onnx');
const TTS_DIR = process.env.AD_TTS_DIR || '/mnt/HC_Volume_103240961/prodops/cache/audio-ads';
const FFMPEG = process.env.AD_TTS_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.AD_TTS_FFPROBE || 'ffprobe';
const RENDERS = process.env.AD_TTS_COLLECTION || 'ad_tts_renders';
// Podcast loudness (-16 LUFS), then the same 2 dB under the content as the video rolls.
const TARGET_LUFS = parseFloat(process.env.AD_TTS_TARGET_LUFS) || -16;
const GAIN_DB = Number.isFinite(parseFloat(process.env.AD_GAIN_DB)) ? parseFloat(process.env.AD_GAIN_DB) : -2;
const CHIME = parseBool(process.env.AD_TTS_CHIME, true);
/* The calm music under the voice. 'pad' (default) is generated here: two soft chords
 * (Fmaj7, Cmaj7) slowly cross-fading, so it is ours outright and needs no credit,
 * which a spoken spot has no way to give. A path plays that file instead, looped and
 * faded (a CC0 track; CC BY would need an attribution). 'off' = voice only. */
const BED = String(process.env.AD_TTS_BED || 'pad').trim();
// How far under the voice the music sits, in dB (both are levelled first, so this is exact).
const BED_DB = Number.isFinite(parseFloat(process.env.AD_TTS_BED_DB)) ? parseFloat(process.env.AD_TTS_BED_DB) : -17;
const BED_TAIL_S = 1.2;
const INTERVAL_MIN = parseInt(process.env.AD_TTS_INTERVAL_MIN, 10) || 2;
const BATCH = parseInt(process.env.AD_TTS_BATCH, 10) || 10;
const MAX_ATTEMPTS = 3;
// Bump when the spoken template or the mix changes: every message renders again.
const TEMPLATE = 'v1';

const AUDIO_TICKER_ENABLED = parseBool(process.env.AD_AUDIO_TICKER_ENABLED, true);
const AUDIO_TICKER_ALLOWED_OWNERS = String(process.env.AD_AUDIO_TICKER_ALLOWED_OWNERS ?? 'badadib')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** May an audio spot play on this owner's audio? Empty list = everyone. */
function audioTickerAllowedOn(owner) {
  if (!AUDIO_TICKER_ALLOWED_OWNERS.length) return true;
  return AUDIO_TICKER_ALLOWED_OWNERS.includes(String(owner || '').toLowerCase());
}

/**
 * The message as it should be SAID. A ticker is written to be read: links, handles,
 * hashtags and emoji read aloud are noise ("h t t p s colon slash slash").
 */
function speakable(message) {
  let s = String(message || '');
  s = s.replace(/https?:\/\//gi, '').replace(/\bwww\./gi, '');
  // A link's path is never worth saying: "shop.io/spring?ref=3s" -> "shop.io".
  s = s.replace(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/\S*/gi, '$1');
  s = s.replace(/[#@](\w)/g, '$1');
  s = s.replace(/\p{Extended_Pictographic}|️|‍/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s && !/[.!?…]$/.test(s)) s += '.';
  return s;
}

// Said last when the message has a link: the player shows a "Find out more" button
// for the length of the spot.
const OUTRO = 'Click the link in the player to find out more.';

/** The full spoken text: the disclosure first, always, then the message, then the way to the link. */
function spokenText(creative, brand) {
  // Trailing punctuation dropped, or "Freedom isn't free,..." is said with a stutter.
  const product = String((brand && brand.projectName) || '').replace(/\s+/g, ' ').trim()
    .replace(/[\s.,;:!?…-]+$/u, '');
  const intro = product ? `Sponsored message from ${product}.` : 'Sponsored message.';
  const body = speakable(creative && creative.message);
  const outro = creative && creative.clickUrl ? ` ${OUTRO}` : '';
  return `${body ? `${intro} ${body}` : intro}${outro}`;
}

function voiceName() {
  return path.basename(VOICE).replace(/\.onnx$/, '');
}

function ttsHash(text) {
  return crypto.createHash('sha1')
    .update(`${TEMPLATE}\n${voiceName()}\n${CHIME ? 'chime' : 'plain'}\n${bedId()}\n${text}`).digest('hex');
}

/** Which music bed, as part of the file's identity: changing it renders everything again. */
function bedId() {
  if (BED === 'off') return 'bed:off';
  if (BED === 'pad') return `bed:pad1:${BED_DB}`;
  return `bed:${path.basename(BED)}:${BED_DB}`;
}

/* The generated pad: each chord a few sines, every note doubled slightly sharp for
 * warmth and swelling on its own slow cycle, the two chords trading places every 8 s. */
const PAD_A = [174.61, 220.0, 261.63, 329.63];   // Fmaj7
const PAD_B = [130.81, 164.81, 196.0, 246.94];   // Cmaj7
function padExpr() {
  const chord = (notes, phase) => notes.map((f, i) => (
    `(sin(2*PI*${f}*t)+0.5*sin(2*PI*${(f * 1.004).toFixed(3)}*t))*(0.75+0.25*sin(2*PI*0.13*t+${(i * 1.7 + phase).toFixed(2)}))`
  )).join('+');
  const w = '(0.5+0.5*cos(2*PI*t/16))';
  return `0.06*(${w}*(${chord(PAD_A, 0)})+(1-${w})*(${chord(PAD_B, 0.9)}))`;
}

const TTS_FILE_RE = /^[0-9a-f]{40}\.mp3$/;
function ttsFilePath(file) {
  return TTS_FILE_RE.test(String(file || '')) ? path.join(TTS_DIR, file) : null;
}

/** Can this box render at all? Checked once per sweep; cheap. */
function engineReady() {
  try {
    fs.accessSync(PIPER_BIN, fs.constants.X_OK);
    fs.accessSync(VOICE, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, { input, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').slice(-500); reject(err); return; }
      resolve(String(stdout || ''));
    });
    if (input != null) { child.stdin.end(input); }
  });
}

/**
 * Text -> MP3. Piper speaks it to a WAV, ffmpeg puts the chime in front, levels it
 * and encodes. Written to a temp name and renamed, so a half-written file is never
 * served. Returns the duration in seconds.
 */
async function renderToFile(text, outFile) {
  fs.mkdirSync(TTS_DIR, { recursive: true });
  const tmpBase = path.join(TTS_DIR, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const wav = `${tmpBase}.wav`;
  const mp3 = `${tmpBase}.mp3`;
  try {
    // One line in = one utterance out. --sentence_silence: a breath after the disclosure.
    await run(PIPER_BIN, ['--model', VOICE, '--output_file', wav, '--sentence_silence', '0.3'], {
      input: `${text.replace(/\s+/g, ' ')}\n`,
    });
    const level = `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11,volume=${GAIN_DB}dB,aresample=44100`;
    const MONO = 'aformat=sample_rates=22050:channel_layouts=mono';
    const speech = parseFloat(await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav])) || 0;
    const lead = CHIME ? 0.7 : 0;
    const withBed = BED !== 'off';
    // The music starts with the chime and runs a moment past the last word.
    const total = Math.round((lead + speech + 0.4 + (withBed ? BED_TAIL_S : 0)) * 100) / 100;

    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    const graph = [];
    let n = 0;
    if (CHIME) {
      // Two soft notes (A5, E6) and a short gap: the "here comes a message" cue.
      args.push(
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.14:sample_rate=22050',
        '-f', 'lavfi', '-i', 'sine=frequency=1318.5:duration=0.26:sample_rate=22050',
        '-f', 'lavfi', '-i', 'aevalsrc=0:duration=0.3:sample_rate=22050',
      );
      n = 3;
    }
    args.push('-i', wav);
    const wavIn = n++;
    if (CHIME) {
      graph.push(
        '[0]volume=0.2,afade=t=in:d=0.01,afade=t=out:st=0.07:d=0.07[ca]',
        '[1]volume=0.2,afade=t=in:d=0.01,afade=t=out:st=0.08:d=0.18[cb]',
        `[${wavIn}]${MONO},loudnorm=I=-16,aresample=22050[sp]`,
        `[ca][cb][2][sp]concat=n=4:v=0:a=1,apad=whole_dur=${total}[voice]`,
      );
    } else {
      graph.push(`[${wavIn}]${MONO},loudnorm=I=-16,aresample=22050,apad=whole_dur=${total}[voice]`);
    }
    if (withBed) {
      const fades = `afade=t=in:d=0.8,afade=t=out:st=${Math.max(0, total - BED_TAIL_S - 0.3)}:d=${BED_TAIL_S + 0.3}`;
      if (BED === 'pad') {
        args.push('-f', 'lavfi', '-i', `aevalsrc='${padExpr()}':s=22050:d=${total}`);
        // Soft and a little roomy: the top cut away, two quiet echoes.
        graph.push(`[${n}]lowpass=f=1100,aecho=0.8:0.6:180|320:0.3|0.18,loudnorm=I=-16,aresample=22050,volume=${BED_DB}dB,${fades}[bed]`);
      } else {
        args.push('-stream_loop', '-1', '-i', BED);
        graph.push(`[${n}]${MONO},atrim=0:${total},asetpts=N/SR/TB,loudnorm=I=-16,aresample=22050,volume=${BED_DB}dB,${fades}[bed]`);
      }
      graph.push(`[voice][bed]amix=inputs=2:duration=first:normalize=0,${level}[out]`);
    } else {
      graph.push(`[voice]${level}[out]`);
    }
    args.push('-filter_complex', graph.join(';'), '-map', '[out]');
    args.push('-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', mp3);
    await run(FFMPEG, args);
    const probed = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3]);
    const durationSeconds = Math.round((parseFloat(probed) || 0) * 100) / 100;
    if (!(durationSeconds > 0)) throw new Error('rendered file has no duration');
    fs.renameSync(mp3, outFile);
    return durationSeconds;
  } finally {
    for (const f of [wav, mp3]) { try { fs.unlinkSync(f); } catch { /* not there */ } }
  }
}

let indexed = false;
async function ensureIndexes(db) {
  if (indexed) return;
  indexed = true;
  try { await db.collection(RENDERS).createIndex({ creativeId: 1, renderedAt: -1 }); } catch { /* exists */ }
}

/** Render one creative now (the sweep and the CLI both come through here). */
async function renderCreative(db, creative, brand, { force = false } = {}) {
  await ensureIndexes(db);
  const text = spokenText(creative, brand);
  const hash = ttsHash(text);
  const file = `${hash}.mp3`;
  const out = ttsFilePath(file);
  const prior = await db.collection(RENDERS).findOne({ _id: hash });
  if (!force && prior && prior.status === 'ready' && fs.existsSync(out)) return prior;
  if (!force && prior && prior.status === 'failed' && (prior.attempts || 0) >= MAX_ATTEMPTS) return prior;
  try {
    const durationSeconds = await renderToFile(text, out);
    const doc = {
      hash, creativeId: creative.embedId, text, voice: voiceName(), file,
      durationSeconds, status: 'ready', error: null, renderedAt: new Date(),
    };
    await db.collection(RENDERS).updateOne({ _id: hash }, { $set: doc, $setOnInsert: { attempts: 0 } }, { upsert: true });
    return { _id: hash, ...doc };
  } catch (err) {
    const error = `${(err && err.message) || err}${err && err.stderr ? ` | ${err.stderr}` : ''}`.slice(0, 600);
    await db.collection(RENDERS).updateOne(
      { _id: hash },
      { $set: { hash, creativeId: creative.embedId, text, voice: voiceName(), file, status: 'failed', error, failedAt: new Date() }, $inc: { attempts: 1 } },
      { upsert: true },
    );
    console.error(`[ad-tts] render failed for ${creative.embedId}: ${error}`);
    return null;
  }
}

/**
 * The playable render for each creative, keyed by embedId, for exactly the text it
 * would be spoken with TODAY (product name included). A creative whose current text
 * has no file yet is simply absent: it waits for the next sweep.
 */
async function readyRendersFor(db, items) {
  const want = new Map();
  for (const { creative, brand } of items) {
    if (!creative || !creative.embedId) continue;
    want.set(ttsHash(spokenText(creative, brand)), creative.embedId);
  }
  if (!want.size) return new Map();
  const rows = await db.collection(RENDERS)
    .find({ _id: { $in: [...want.keys()] }, status: 'ready' })
    .project({ file: 1, durationSeconds: 1, hash: 1 })
    .toArray();
  const out = new Map();
  for (const r of rows) {
    const p = ttsFilePath(r.file);
    if (p && fs.existsSync(p)) out.set(want.get(r._id), r);
  }
  return out;
}

/** One sweep: every ticker message that is waiting for review or approved. */
async function runOnce() {
  if (!ENABLE_MONGO_WRITES || !engineReady()) return null;
  try {
    const { getDb } = require('./db');
    const db = getDb();
    const creatives = await db.collection(AD_CREATIVES_COLLECTION)
      .find({ kind: 'text', status: { $in: ['review', 'ready'] } })
      .project({ embedId: 1, advertiserRef: 1, message: 1, clickUrl: 1 })
      .sort({ _id: -1 })
      .limit(200)
      .toArray();
    if (!creatives.length) return { checked: 0, rendered: 0 };
    const refs = [...new Set(creatives.map((c) => c.advertiserRef).filter(Boolean))];
    const brands = new Map((await db.collection(ADVERTISERS_COLLECTION)
      .find({ reference: { $in: refs } }, { projection: { reference: 1, projectName: 1 } })
      .toArray()).map((b) => [b.reference, b]));
    const have = await readyRendersFor(db, creatives.map((c) => ({ creative: c, brand: brands.get(c.advertiserRef) })));
    let rendered = 0;
    for (const c of creatives) {
      if (rendered >= BATCH) break;
      if (have.has(c.embedId)) continue;
      const r = await renderCreative(db, c, brands.get(c.advertiserRef));
      if (r && r.status === 'ready') rendered += 1;
    }
    if (rendered) console.log(`[ad-tts] rendered ${rendered} spoken ticker(s)`);
    return { checked: creatives.length, rendered };
  } catch (err) {
    console.error('[ad-tts] sweep failed:', err && err.message);
    return null;
  }
}

/* ─── pre-listen: the advertiser hears it before saving ───────────────────
 *
 * The SAME text, voice, chime and music as a served spot, so the same hash and the
 * same file: what the advertiser hears on /advertise is byte for byte what a
 * listener will get, and saving that message afterwards needs no second render (the
 * sweep finds it ready). An unchanged message costs nothing: it is the cached file.
 *
 * A render is ~1 s of CPU, so they run ONE at a time with a short queue, and each
 * advertiser gets PREVIEW_PER_HOUR new renders an hour (cached replays are free). */
const PREVIEW_PER_HOUR = parseInt(process.env.AD_TTS_PREVIEWS_PER_HOUR, 10) || 30;
const PREVIEW_QUEUE_MAX = 4;
const previewLog = new Map();   // reference -> timestamps of renders in the last hour
let previewChain = Promise.resolve();
let previewQueued = 0;

function previewAllowed(reference) {
  const now = Date.now();
  const recent = (previewLog.get(reference) || []).filter((t) => now - t < 3600 * 1000);
  previewLog.set(reference, recent);
  return recent.length < PREVIEW_PER_HOUR;
}

/**
 * Render (or find) the spot for a message that may not be saved yet. Resolves
 * { file, durationSeconds, text, cached } or rejects with err.code
 * 'tts_unavailable' | 'tts_busy' | 'tts_limit' | 'tts_failed'.
 */
async function previewRender(db, { message, clickUrl }, brand, reference) {
  const fail = (code) => Object.assign(new Error(code), { code });
  if (!engineReady()) throw fail('tts_unavailable');
  await ensureIndexes(db);
  const text = spokenText({ message, clickUrl }, brand);
  const hash = ttsHash(text);
  const file = `${hash}.mp3`;
  const out = ttsFilePath(file);
  const ready = async () => {
    const row = await db.collection(RENDERS).findOne({ _id: hash, status: 'ready' });
    return row && fs.existsSync(out) ? row : null;
  };
  const have = await ready();
  if (have) return { file, durationSeconds: have.durationSeconds, text, cached: true };
  if (!previewAllowed(reference)) throw fail('tts_limit');
  if (previewQueued >= PREVIEW_QUEUE_MAX) throw fail('tts_busy');

  previewQueued += 1;
  const job = previewChain.then(async () => {
    // Someone else may have rendered the same text while this one waited.
    const again = await ready();
    if (again) return { file, durationSeconds: again.durationSeconds, text, cached: true };
    previewLog.get(reference).push(Date.now());
    let durationSeconds;
    try {
      durationSeconds = await renderToFile(text, out);
    } catch (err) {
      console.error(`[ad-tts] preview render failed: ${(err && err.message) || err}`);
      throw fail('tts_failed');
    }
    await db.collection(RENDERS).updateOne(
      { _id: hash },
      {
        $set: { hash, text, voice: voiceName(), file, durationSeconds, status: 'ready', error: null, renderedAt: new Date() },
        $setOnInsert: { creativeId: null, preview: true, attempts: 0 },
      },
      { upsert: true },
    );
    return { file, durationSeconds, text, cached: false };
  });
  previewChain = job.catch(() => {}).finally(() => { previewQueued -= 1; });
  return job;
}

function enabled() {
  return ENABLE_MONGO_WRITES && engineReady();
}

module.exports = {
  AUDIO_TICKER_ENABLED, AUDIO_TICKER_ALLOWED_OWNERS, INTERVAL_MIN, TTS_FILE_RE,
  audioTickerAllowedOn, speakable, spokenText, ttsHash, ttsFilePath,
  engineReady, enabled, renderCreative, readyRendersFor, runOnce, previewRender,
};
