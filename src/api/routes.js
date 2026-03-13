const { Router } = require('express');
const { getTweets, getTweetHistory, getStats, getBlacklist, addToBlacklist, removeFromBlacklist } = require('../db/queries');
const { runFetch, runRefresh, state } = require('../scheduler');
const config = require('../config');

const router = Router();

// ─── GET /api/tweets ──────────────────────────────────────────────────────────
// Query params:
//   status     = all | normal | fast | parabolic
//   sort       = likes | views | virality | growth | newest
//   has_media  = true | false
//   min_likes  = <number>
//   author     = <partial handle>
//   limit      = <number, max 500>

router.get('/tweets', async (req, res) => {
  try {
    const tweets = await getTweets(req.query);
    res.json({ ok: true, count: tweets.length, tweets });
  } catch (err) {
    console.error('[API] GET /tweets:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/tweets/:id/history ─────────────────────────────────────────────

router.get('/tweets/:id/history', async (req, res) => {
  try {
    const history = await getTweetHistory(req.params.id);
    res.json({ ok: true, count: history.length, history });
  } catch (err) {
    console.error('[API] GET /tweets/:id/history:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({
      ok: true,
      stats: {
        ...stats,
        scheduler: {
          lastFetch:      state.lastFetch,
          lastRefresh:    state.lastRefresh,
          fetchRunning:   state.fetchRunning,
          refreshRunning: state.refreshRunning,
          lastFetchError: state.lastFetchError,
          lastFetchCount: state.lastFetchCount,
        },
      },
    });
  } catch (err) {
    console.error('[API] GET /stats:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Blacklist endpoints ──────────────────────────────────────────────────────

router.get('/blacklist', async (req, res) => {
  try {
    const list = await getBlacklist();
    res.json({ ok: true, blacklist: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/blacklist', async (req, res) => {
  const handle = (req.body?.handle || '').trim();
  if (!handle) return res.status(400).json({ ok: false, error: 'handle required' });
  try {
    await addToBlacklist(handle);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/blacklist/:handle', async (req, res) => {
  try {
    await removeFromBlacklist(req.params.handle);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/config ──────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
  res.json({ ok: true, config });
});

// ─── POST /api/config ─────────────────────────────────────────────────────────
// Body: { minLikes?: number, hoursBack?: number }
// Updates runtime search parameters without restarting.

router.post('/config', (req, res) => {
  const { minLikes, minRetweets, language } = req.body || {};

  if (minLikes !== undefined) {
    const v = parseInt(minLikes, 10);
    if (isNaN(v) || v < 1) return res.status(400).json({ ok: false, error: 'minLikes must be a positive integer' });
    config.minLikes = v;
  }

  if (minRetweets !== undefined) {
    const v = parseInt(minRetweets, 10);
    if (isNaN(v) || v < 0) return res.status(400).json({ ok: false, error: 'minRetweets must be >= 0' });
    config.minRetweets = v;
  }

  if (language !== undefined) {
    // Accept 'en', any ISO 639-1 code, or null/empty to clear
    config.language = language || null;
  }

  console.log(`[Config] Updated: minLikes=${config.minLikes} minRetweets=${config.minRetweets} language=${config.language || 'any'}`);
  res.json({ ok: true, config });
});

// ─── POST /api/refresh ────────────────────────────────────────────────────────
// Manually trigger a fetch or refresh cycle.
// Body: { type: "fetch" | "refresh" }

router.post('/refresh', async (req, res) => {
  const type = req.body?.type || 'fetch';

  if (type !== 'fetch' && type !== 'refresh') {
    return res.status(400).json({ ok: false, error: 'type must be "fetch" or "refresh"' });
  }

  // Kick off without awaiting – response returns immediately
  if (type === 'fetch') {
    runFetch();
  } else {
    runRefresh();
  }

  res.json({ ok: true, message: `${type} job started` });
});

module.exports = router;
