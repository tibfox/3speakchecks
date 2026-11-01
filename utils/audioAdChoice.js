/**
 * Per-audio ad choice: the uploader's "Ads on this audio" switch, which OVERRIDES the
 * creator's account setting ("Ads on your audio") for one track, in either direction.
 *
 * Same trust model as utils/videoAdOptOut.js: the record of the choice is the Hive
 * post. The uploader writes `json_metadata["3speak"].audioAds = true | false` into the
 * audio's post, which the creator signs as part of publishing it; the sync route reads
 * the post off the chain and mirrors what it finds. Calling it for somebody else's
 * post can only ever copy THEIR choice.
 *
 * Only written when the creator moved the switch away from their account setting, so
 * a track without the key keeps following the account (and any later change to it).
 *
 * The post does not name its audio file, so the asset is found the other way round:
 * the embed-audio row whose owner is the post's author and whose `post_permlink` is
 * this post (set by the upload right after publishing). The owner match is what
 * stops a post from setting the choice on somebody else's audio.
 *
 * Mirror: AD_AUDIO_CHOICES_COLLECTION, `_id` = `owner/audioPermlink` (what an ad
 * session knows), `ads` true | false. A post without the key deletes the row.
 */
const { getDb } = require('./db');
const { hiveRpcBatch } = require('./hive');

const COLLECTION = process.env.AD_AUDIO_CHOICES_COLLECTION || 'ad_audio_choices';
const META_NS = '3speak';
const norm = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');
const keyOf = (owner, audioPermlink) => `${norm(owner)}/${String(audioPermlink || '').trim()}`;

function parseMeta(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

/** true / false when the post carries a choice, null when it follows the account. */
function audioAdsIn(meta) {
  const ns = meta && meta[META_NS];
  if (!ns || typeof ns !== 'object') return null;
  return typeof ns.audioAds === 'boolean' ? ns.audioAds : null;
}

/** Mirror one post's choice. `{ owner, permlink, audioAds }` or `{ notFound }`. */
async function applyAudioAdChoice(author, hivePermlink, meta) {
  const a = norm(author);
  const db = getDb();
  const asset = await db.collection('embed-audio').findOne(
    { owner: a, post_permlink: hivePermlink },
    { projection: { owner: 1, permlink: 1 } },
  );
  // Not linked yet (the upload links it right after the broadcast): ask again.
  if (!asset) return { notFound: true };
  const choice = audioAdsIn(parseMeta(meta));
  const coll = db.collection(COLLECTION);
  const _id = keyOf(asset.owner, asset.permlink);
  if (choice === null) {
    await coll.deleteOne({ _id });
  } else {
    await coll.updateOne(
      { _id },
      { $set: { owner: norm(asset.owner), permlink: asset.permlink, ads: choice, hiveAuthor: a, hivePermlink, updatedAt: new Date() } },
      { upsert: true },
    );
  }
  return { owner: norm(asset.owner), permlink: asset.permlink, audioAds: choice };
}

/** Read the post from the chain and mirror it. null = the chain could not be read. */
async function syncAudioAdChoiceFromChain(author, hivePermlink) {
  const [res] = await hiveRpcBatch([{
    jsonrpc: '2.0', id: 1, method: 'condenser_api.get_content', params: [norm(author), hivePermlink],
  }]);
  if (!res) return null;
  if (res.error) return /does not exist/i.test(JSON.stringify(res.error)) ? { notFound: true } : null;
  const c = res.result;
  if (!c || c.author !== norm(author) || c.permlink !== hivePermlink) return { notFound: true };
  return applyAudioAdChoice(c.author, c.permlink, c.json_metadata);
}

/** Serve path: this track's own choice, true / false, or null (follow the account). */
async function audioAdChoice(owner, audioPermlink) {
  if (!owner || !audioPermlink) return null;
  const doc = await getDb().collection(COLLECTION)
    .findOne({ _id: keyOf(owner, audioPermlink) }, { projection: { ads: 1 } });
  return doc && typeof doc.ads === 'boolean' ? doc.ads : null;
}

module.exports = { applyAudioAdChoice, syncAudioAdChoiceFromChain, audioAdChoice, audioAdsIn };
