const cron = require('node-cron');
const { fetchViralTweets, refreshTrackedTweets } = require('../twitter/search');
const { cleanup } = require('../db/queries');

// Shared state so the API can read the last-run timestamps
const state = {
  lastFetch:   null,
  lastRefresh: null,
  fetchRunning:   false,
  refreshRunning: false,
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
    await fetchViralTweets();
    state.lastFetch = new Date();
  } catch (err) {
    console.error('[Scheduler] fetchViralTweets error:', err.message);
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
  // Fetch new viral tweets every 30 minutes
  cron.schedule('*/30 * * * *', runFetch);

  // Refresh metrics for tracked tweets every 60 minutes
  cron.schedule('0 * * * *', runRefresh);

  // Daily cleanup at 03:00
  cron.schedule('0 3 * * *', runCleanup);

  console.log('[Scheduler] Jobs scheduled: fetch=30min, refresh=60min, cleanup=daily 03:00');

  // Run fetch immediately on startup so data is available right away
  setImmediate(runFetch);
}

// Manual triggers exposed to the API
module.exports = { start, runFetch, runRefresh, state };
