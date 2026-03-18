'use strict';

const cron = require('node-cron');
const { fetchHiringTweets, fetchVipTimelines } = require('../twitter/search');

const state = {
  lastFetch:              null,
  fetchRunning:           false,
  lastFetchError:         null,
  lastFetchCount:         null,
  consecutiveZeroFetches: 0,
};

async function runFetch() {
  if (state.fetchRunning) {
    console.log('[Scheduler] fetch already running, skipping');
    return;
  }
  state.fetchRunning = true;
  try {
    console.log('[Scheduler] Starting fetchHiringTweets …');
    const count = await fetchHiringTweets();
    state.lastFetch      = new Date();
    state.lastFetchCount = count;
    state.lastFetchError = null;
    if (count > 0) state.consecutiveZeroFetches = 0;
    else           state.consecutiveZeroFetches++;
  } catch (err) {
    console.error('[Scheduler] fetchHiringTweets error:', err.message);
    state.lastFetchError = err.message;
  } finally {
    state.fetchRunning = false;
  }

  // VIP timelines fire-and-forget right after
  fetchVipTimelines().catch((err) =>
    console.error('[Scheduler] fetchVipTimelines error:', err.message)
  );
}

function start() {
  // Every 15 minutes — slightly slower than TWITTERATI since hiring posts
  // don't disappear and we run 6 queries per cycle
  cron.schedule('*/15 * * * *', runFetch);

  console.log('[Scheduler] Jobs scheduled: fetch=15min');

  setImmediate(runFetch);
}

module.exports = { start, runFetch, state };
