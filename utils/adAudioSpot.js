/**
 * The AUDIO SPOT's file: an advertiser's own clip, uploaded to the checker, levelled
 * and stored next to the spoken tickers, then served by the same route
 * (GET /m/tts/<sha1>.mp3, routes/adServe.js) to the audio player.
 *
 * What happens to an upload:
 *   1. the first bytes must look like a sound file we accept (MP3, WAV, Ogg/Opus,
 *      FLAC, AAC, M4A/MP4 or WebM). Checked in Node BEFORE ffmpeg ever sees it, so a
 *      playlist or concat file (which ffmpeg would follow to other files) never runs;
 *   2. ffprobe: an audio stream, longer than a second, no longer than the format allows;
 *   3. ffmpeg: first audio stream only, levelled to the same -16 LUFS as the spoken
 *      tickers plus AD_GAIN_DB (the -2 dB every ad sits under the content), 44.1 kHz,
 *      at most stereo, MP3 128 kbit/s. Metadata and cover art dropped;
 *   4. named by the hash of the RESULT, so the same clip uploaded twice is one file.
 *
 * What the advertiser hears back on /advertise is this file: exactly what listeners get.
 * One file is processed at a time, with a short queue.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { ttsFilePath } = require('./adTts');

const FFMPEG = process.env.AD_TTS_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.AD_TTS_FFPROBE || 'ffprobe';
const TARGET_LUFS = parseFloat(process.env.AD_TTS_TARGET_LUFS) || -16;
const GAIN_DB = Number.isFinite(parseFloat(process.env.AD_GAIN_DB)) ? parseFloat(process.env.AD_GAIN_DB) : -2;
const MIN_SECONDS = 1;
const QUEUE_MAX = 3;

function run(cmd, args, timeout = 90000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').slice(-500); reject(err); return; }
      resolve(String(stdout || ''));
    });
  });
}

/** Does this buffer start like a sound file we take? Returns a short name or null. */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  const ascii = (a, b) => buf.toString('latin1', a, b);
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'aac';          // ADTS
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';          // MPEG frame sync
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(4, 8) === 'ftyp') return 'mp4';
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  return null;
}

function fail(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra });
}

let chain = Promise.resolve();
let queued = 0;

/**
 * Buffer in, stored MP3 out: { file, durationSeconds, sha1 }. Rejects with err.code
 * 'audio_not_supported' | 'audio_no_stream' | 'audio_too_short' | 'audio_too_long'
 * (err.seconds, err.max) | 'audio_busy' | 'audio_failed'.
 */
function processUpload(buf, { maxSeconds }) {
  if (!sniff(buf)) return Promise.reject(fail('audio_not_supported'));
  if (queued >= QUEUE_MAX) return Promise.reject(fail('audio_busy'));
  queued += 1;
  const job = chain.then(() => processNow(buf, maxSeconds));
  chain = job.catch(() => {}).finally(() => { queued -= 1; });
  return job;
}

async function processNow(buf, maxSeconds) {
  const probeTarget = ttsFilePath(`${'0'.repeat(40)}.mp3`);
  const dir = path.dirname(probeTarget);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `.up-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const input = `${base}.in`;
  const output = `${base}.mp3`;
  try {
    fs.writeFileSync(input, buf);
    let probe;
    try {
      probe = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json',
        '-show_entries', 'format=duration:stream=codec_type,channels', input], 30000));
    } catch {
      throw fail('audio_not_supported');
    }
    const audio = (probe.streams || []).find((s) => s.codec_type === 'audio');
    if (!audio) throw fail('audio_no_stream');
    const seconds = parseFloat(probe.format && probe.format.duration) || 0;
    if (seconds < MIN_SECONDS) throw fail('audio_too_short');
    if (seconds > maxSeconds + 0.5) throw fail('audio_too_long', { seconds: Math.ceil(seconds), max: maxSeconds });

    const channels = Math.min(2, Math.max(1, Number(audio.channels) || 2));
    try {
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
        '-af', `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11,volume=${GAIN_DB}dB,aresample=44100`,
        '-ac', String(channels), '-c:a', 'libmp3lame', '-b:a', '128k', output]);
    } catch (err) {
      console.error(`[ad-audio] encode failed: ${(err && err.message) || err} ${err && err.stderr ? `| ${err.stderr}` : ''}`);
      throw fail('audio_failed');
    }
    const durationSeconds = Math.round((parseFloat(await run(FFPROBE, ['-v', 'error',
      '-show_entries', 'format=duration', '-of', 'csv=p=0', output], 30000)) || 0) * 100) / 100;
    if (!(durationSeconds > 0)) throw fail('audio_failed');

    const sha1 = crypto.createHash('sha1').update(fs.readFileSync(output)).digest('hex');
    const file = `${sha1}.mp3`;
    fs.renameSync(output, ttsFilePath(file));
    return { file, durationSeconds, sha1 };
  } finally {
    for (const f of [input, output]) { try { fs.unlinkSync(f); } catch { /* not there */ } }
  }
}

module.exports = { processUpload, sniff };
