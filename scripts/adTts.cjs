#!/usr/bin/env node
/**
 * Spoken tickers (utils/adTts.js), the operator side.
 *
 *   node scripts/adTts.cjs status               # engine, gates, last renders
 *   node scripts/adTts.cjs text   <embedId>     # what would be said, without rendering
 *   node scripts/adTts.cjs render <embedId>     # render now (again), print the link
 *   node scripts/adTts.cjs sweep                # one pass of the background renderer
 *
 * <embedId> is the ticker creative's key (txt:...), as `advertisers.cjs creatives`
 * lists it. Listen before approving: the link works for a message still in review,
 * though nothing serves until the creative is approved.
 */
require('dotenv').config();
const { connectToMongo, getDb } = require('../utils/db');
const { AD_CREATIVES_COLLECTION, ADVERTISERS_COLLECTION } = require('../utils/config');
const tts = require('../utils/adTts');

const PUBLIC = process.env.CHECKER_PUBLIC_URL || 'https://checker.3speak.tv';

async function creativeAndBrand(db, embedId) {
  const creative = await db.collection(AD_CREATIVES_COLLECTION).findOne({ embedId, kind: 'text' });
  if (!creative) return {};
  const brand = creative.advertiserRef
    ? await db.collection(ADVERTISERS_COLLECTION).findOne({ reference: creative.advertiserRef }, { projection: { projectName: 1 } })
    : null;
  return { creative, brand };
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  await connectToMongo();
  const db = getDb();

  if (cmd === 'status' || !cmd) {
    console.log(`engine ready:     ${tts.engineReady()}`);
    console.log(`serving enabled:  ${tts.AUDIO_TICKER_ENABLED}`);
    console.log(`allowed owners:   ${tts.AUDIO_TICKER_ALLOWED_OWNERS.length ? tts.AUDIO_TICKER_ALLOWED_OWNERS.join(', ') : '(everyone)'}`);
    const rows = await db.collection(process.env.AD_TTS_COLLECTION || 'ad_tts_renders')
      .find({}).sort({ renderedAt: -1, failedAt: -1 }).limit(15).toArray();
    for (const r of rows) {
      console.log(`${r.status.padEnd(6)} ${String(r.creativeId).padEnd(28)} ${r.durationSeconds ? `${r.durationSeconds}s` : ''} `
        + `${r.status === 'ready' ? `${PUBLIC}/m/tts/${r.file}` : (r.error || '')}`);
      console.log(`       "${r.text}"`);
    }
    return;
  }
  if (cmd === 'sweep') { console.log(await tts.runOnce()); return; }
  if (cmd === 'text' || cmd === 'render') {
    if (!arg) { console.error(`Usage: node scripts/adTts.cjs ${cmd} <embedId>`); process.exitCode = 1; return; }
    const { creative, brand } = await creativeAndBrand(db, arg);
    if (!creative) { console.error(`No ticker creative ${arg}`); process.exitCode = 1; return; }
    console.log(`"${tts.spokenText(creative, brand)}"`);
    if (cmd === 'text') return;
    if (!tts.engineReady()) { console.error('Piper or its voice is missing on this box.'); process.exitCode = 1; return; }
    const r = await tts.renderCreative(db, creative, brand, { force: true });
    if (!r) { process.exitCode = 1; return; }
    console.log(`${r.durationSeconds}s  ${PUBLIC}/m/tts/${r.file}`);
    return;
  }
  console.error('Commands: status | text <embedId> | render <embedId> | sweep');
  process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 200));
