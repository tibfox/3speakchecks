/**
 * Build the Pulse hot set once and PRINT it, with how long each step took. Writes
 * nothing, and works with PULSE_HOTSET_ENABLED off, so it can be run against
 * production Mongo before the flag is turned on, to check the query cost and
 * whether the thresholds give a sensible list size.
 *
 * Usage:
 *   node scripts/pulse-hot-set.js                                  # the configured window/thresholds
 *   PULSE_HOTSET_MIN_SESSIONS=3 node scripts/pulse-hot-set.js       # try another threshold
 *   node scripts/pulse-hot-set.js --explain                         # also print the aggregation's plan summary
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');
const { buildHotSet, watchedPipeline, WATCH_LOG } = require('../services/pulseHotSet');
const {
  MONGODB_URI, DATABASE_NAME, PULSE_HOTSET_WINDOW_HOURS, PULSE_HOTSET_MIN_SESSIONS, PULSE_HOTSET_MIN_AGE_DAYS, PULSE_HOTSET_LIMIT,
} = require('../utils/config');

(async () => {
  // Its own small client rather than utils/db.js's connectToMongo(), which also
  // ensures indexes on connect. This script must not write anything.
  const client = new MongoClient(MONGODB_URI, { maxPoolSize: 2 });
  await client.connect();
  const db = client.db(DATABASE_NAME);
  const now = new Date();

  if (process.argv.includes('--explain')) {
    // Same pipeline as the build, run through explain so the plan shows whether
    // the updatedAt index is used and how many rows the window matched.
    const cutoff = new Date(now - PULSE_HOTSET_WINDOW_HOURS * 60 * 60 * 1000);
    const pipeline = watchedPipeline({ cutoff, minSessions: PULSE_HOTSET_MIN_SESSIONS });
    const plan = await db.collection(WATCH_LOG)
      .aggregate(pipeline, { allowDiskUse: true }).explain('executionStats');
    const stage = plan.stages ? plan.stages[0].$cursor : plan;
    const stats = stage && stage.executionStats;
    const winning = stage && stage.queryPlanner && stage.queryPlanner.winningPlan;
    console.log('plan:', JSON.stringify(winning && (winning.inputStage || winning), null, 0).slice(0, 400));
    if (stats) console.log(`rows examined ${stats.totalDocsExamined}, keys examined ${stats.totalKeysExamined}, returned ${stats.nReturned}, ${stats.executionTimeMillis}ms on the server`);
  }

  const t0 = Date.now();
  const { body, stats } = await buildHotSet(db, { now });
  const ms = Date.now() - t0;

  console.log(`window ${PULSE_HOTSET_WINDOW_HOURS}h, min ${PULSE_HOTSET_MIN_SESSIONS} sessions, min age ${PULSE_HOTSET_MIN_AGE_DAYS}d, limit ${PULSE_HOTSET_LIMIT}`);
  console.log(`${stats.watched} videos over the threshold, ${body.count} on the list, built in ${ms}ms`);
  console.log('skipped:', JSON.stringify(stats.skipped));
  const byCollection = body.videos.reduce((acc, v) => ({ ...acc, [v.collection]: (acc[v.collection] || 0) + 1 }), {});
  console.log('by collection:', JSON.stringify(byCollection));
  console.log('top 20:');
  for (const v of body.videos.slice(0, 20)) {
    console.log(`  ${String(v.sessions).padStart(5)}  ${v.collection.padEnd(11)}  ${v.owner}/${v.permlink}`);
  }
  await client.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
