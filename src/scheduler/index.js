const cron = require('node-cron');
const { fetchViralTweets, refreshTrackedTweets, fetchVipTimelines, deepBackfill } = require('../twitter/search');
const { cleanup } = require('../db/queries');

// Shared state so the API can read the last-run timestamps
const state = {
  lastFetch:              null,
  lastRefresh:            null,
  fetchRunning:           false,
  refreshRunning:         false,
  lastFetchError:         null,   // last error message from fetchViralTweets
  lastFetchCount:         null,   // how many tweets were upserted on the last fetch run
  consecutiveZeroFetches: 0,      // increments when fetch returns 0; resets on any result
  coolingDownUntil:       null,   // when rate-limited, skip fetches until this timestamp
};

// ─── Job wrappers ─────────────────────────────────────────────────────────────

async function runFetch() {
  // Skip if we're in a rate-limit cooldown period
  if (state.coolingDownUntil && Date.now() < state.coolingDownUntil) {
    const remaining = Math.ceil((state.coolingDownUntil - Date.now()) / 60000);
    console.log(`[Scheduler] cooling down — skipping fetch (${remaining}min remaining)`);
    return;
  }

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
    if (count > 0) {
      state.consecutiveZeroFetches = 0;
      state.coolingDownUntil = null;
    } else {
      state.consecutiveZeroFetches++;
      if (state.consecutiveZeroFetches >= 3) {
        state.coolingDownUntil = new Date(Date.now() + 30 * 60 * 1000);
        console.log('[Scheduler] 3 consecutive zero fetches — entering 30min rate-limit cooldown');
      }
    }
  } catch (err) {
    console.error('[Scheduler] fetchViralTweets error:', err.message);
    state.lastFetchError = err.message;
  } finally {
    state.fetchRunning = false;
  }

  // VIP timelines run right after the main fetch (fire-and-forget, errors logged internally)
  fetchVipTimelines().catch(err => console.error('[Scheduler] fetchVipTimelines error:', err.message));
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

async function runDeepBackfill() {
  try {
    console.log('[Scheduler] Starting deepBackfill …');
    const count = await deepBackfill();
    console.log(`[Scheduler] deepBackfill complete — ${count} tweets upserted`);
  } catch (err) {
    console.error('[Scheduler] deepBackfill error:', err.message);
  }
}

// ─── Start scheduler ──────────────────────────────────────────────────────────

function start() {
  // Fetch new tweets every 30 minutes — reduced frequency to avoid X rate limits
  cron.schedule('*/30 * * * *', runFetch);

  // Refresh + recalculate acceleration every 30 min, offset by 15 so they interleave with fetch
  cron.schedule('15,45 * * * *', runRefresh);

  // Daily cleanup at 03:00
  cron.schedule('0 3 * * *', runCleanup);

  // Daily deep backfill at 02:00 — 48h lookback at 30K+ threshold
  cron.schedule('0 2 * * *', runDeepBackfill);

  console.log('[Scheduler] Jobs scheduled: fetch=30min, refresh=30min(offset 15min), deep-backfill=daily 02:00, cleanup=daily 03:00');

  // Run fetch immediately on startup so data is available right away
  setImmediate(runFetch);
}

// Manual triggers exposed to the API
module.exports = { start, runFetch, runRefresh, state };
