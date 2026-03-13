const cron = require('node-cron');
const { fetchViralTweets, refreshTrackedTweets } = require('../twitter/search');
const { cleanup } = require('../db/queries');

// Shared state so the API can read the last-run timestamps
const state = {
  lastFetch:        null,
  lastRefresh:      null,
  fetchRunning:     false,
  refreshRunning:   false,
  lastFetchError:   null,   // last error message from fetchViralTweets
  lastFetchCount:   null,   // how many tweets were upserted on the last fetch run
};

// ─── Job wrappers ─────────────────────────────────────────────────────────────

async function runFetch() {
  if (state.fetchRunning) {
    console.log('[Scheduler] fetch already running, skipping');
    return;
  }
  state.fetchRunning = true;
  try {
    console.log('[Scheduler] Starting fetchViralTweets …');
    const count = await fetchViralTweets();
    state.lastFetch      = new Date();
    state.lastFetchCount = count;
    state.lastFetchError = null;
  } catch (err) {
    console.error('[Scheduler] fetchViralTweets error:', err.message);
    state.lastFetchError = err.message;
  } finally {
    state.fetchRunning = false;
  }
}

async function runRefresh() {
  if (state.refreshRunning) {
    console.log('[Scheduler] refresh already running, skipping');
    return;
  }
  state.refreshRunning = true;
  try {
    console.log('[Scheduler] Starting refreshTrackedTweets …');
    await refreshTrackedTweets();
    state.lastRefresh = new Date();
  } catch (err) {
    console.error('[Scheduler] refreshTrackedTweets error:', err.message);
  } finally {
    state.refreshRunning = false;
  }
}

async function runCleanup() {
  try {
    await cleanup();
    console.log('[Scheduler] Cleanup complete');
  } catch (err) {
    console.error('[Scheduler] Cleanup error:', err.message);
  }
}

// ─── Start scheduler ──────────────────────────────────────────────────────────

function start() {
  // Fetch new tweets every 10 minutes — tight loop to catch acceleration early
  cron.schedule('*/10 * * * *', runFetch);

  // Refresh + recalculate acceleration every 10 min, offset by 5 so they interleave with fetch
  cron.schedule('5,15,25,35,45,55 * * * *', runRefresh);

  // Daily cleanup at 03:00
  cron.schedule('0 3 * * *', runCleanup);

  console.log('[Scheduler] Jobs scheduled: fetch=10min, refresh=10min(offset 5min), cleanup=daily 03:00');

  // Run fetch immediately on startup so data is available right away
  setImmediate(runFetch);
}

// Manual triggers exposed to the API
module.exports = { start, runFetch, runRefresh, state };
