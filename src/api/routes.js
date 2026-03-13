const { Router } = require('express');
const { getTweets, getTweetHistory, getStats } = require('../db/queries');
const { runFetch, runRefresh, state } = require('../scheduler');

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
