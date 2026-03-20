'use strict';

const { Router } = require('express');
const {
  getJobs, archiveJob, markFilled,
  getStats, getRoleStats, getSubspaceStats,
  getVipWatchlist, addToVipWatchlist, removeFromVipWatchlist,
} = require('../db/queries');
const { runFetch, state } = require('../scheduler');
const config = require('../config');
const OpenAI = require('openai');

const router = Router();

// ─── GET /api/jobs ────────────────────────────────────────────────────────────
// Query params: role_type, subspace, remote, seniority, search, sort, is_filled, limit

router.get('/jobs', async (req, res) => {
  try {
    const jobs = await getJobs(req.query);
    res.json({ ok: true, count: jobs.length, jobs });
  } catch (err) {
    console.error('[API] GET /jobs:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── PATCH /api/jobs/:id/archive ─────────────────────────────────────────────

router.patch('/jobs/:id/archive', async (req, res) => {
  try {
    await archiveJob(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── PATCH /api/jobs/:id/filled ──────────────────────────────────────────────

router.patch('/jobs/:id/filled', async (req, res) => {
  const filled = req.body?.filled !== false; // default true
  try {
    await markFilled(req.params.id, filled);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────

function cookieHealth() {
  const err = state.lastFetchError || '';
  const authFailed = /401|403|auth|unauthorized|cookie|unauthenticated|forbidden/i.test(err);
  if (authFailed)                          return { status: 'dead',    reason: `Auth error: ${err}` };
  if (state.consecutiveZeroFetches >= 6)   return { status: 'dead',    reason: `No results for ${state.consecutiveZeroFetches} consecutive runs` };
  if (state.consecutiveZeroFetches >= 3)   return { status: 'warn',    reason: `No new jobs for ${state.consecutiveZeroFetches} runs` };
  if (state.lastFetch === null)            return { status: 'unknown', reason: 'No fetch run yet' };
  return { status: 'ok', reason: null };
}

router.get('/stats', async (req, res) => {
  try {
    const [stats, roles, subspaces] = await Promise.all([
      getStats(), getRoleStats(), getSubspaceStats(),
    ]);
    res.json({
      ok: true,
      stats: {
        ...stats,
        scheduler: {
          lastFetch:              state.lastFetch,
          fetchRunning:           state.fetchRunning,
          lastFetchError:         state.lastFetchError,
          lastFetchCount:         state.lastFetchCount,
          consecutiveZeroFetches: state.consecutiveZeroFetches,
          cookieHealth:           cookieHealth(),
        },
      },
      roles,
      subspaces,
    });
  } catch (err) {
    console.error('[API] GET /stats:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/fetch ──────────────────────────────────────────────────────────

router.post('/fetch', (req, res) => {
  runFetch();
  res.json({ ok: true, message: 'fetch job started' });
});

// ─── GET /api/config ──────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
  res.json({ ok: true, config });
});

router.post('/config', (req, res) => {
  const { minLikes, minConfidence } = req.body || {};

  if (minLikes !== undefined) {
    const v = parseInt(minLikes, 10);
    if (isNaN(v) || v < 1) return res.status(400).json({ ok: false, error: 'minLikes must be >= 1' });
    config.minLikes = v;
  }
  if (minConfidence !== undefined) {
    const v = parseFloat(minConfidence);
    if (isNaN(v) || v < 0 || v > 1) return res.status(400).json({ ok: false, error: 'minConfidence must be 0–1' });
    config.minConfidence = v;
  }

  console.log(`[Config] minLikes=${config.minLikes} minConfidence=${config.minConfidence}`);
  res.json({ ok: true, config });
});

// ─── VIP watchlist ────────────────────────────────────────────────────────────

router.get('/vip', async (req, res) => {
  try {
    const list = await getVipWatchlist();
    res.json({ ok: true, vip: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/vip', async (req, res) => {
  const handle = (req.body?.handle || '').trim();
  if (!handle) return res.status(400).json({ ok: false, error: 'handle required' });
  try {
    await addToVipWatchlist(handle);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/vip/:handle', async (req, res) => {
  try {
    await removeFromVipWatchlist(req.params.handle);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/health ──────────────────────────────────────────────────────────
// Live health check for both Twitter cookie and Groq API.
// Makes a real (cheap) call to Groq so you can see if it's actually working.

router.get('/health', async (req, res) => {
  const result = {
    cookie: cookieHealth(),
    groq:   { status: 'unknown', reason: null },
  };

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    result.groq = { status: 'dead', reason: 'GROQ_API_KEY env var not set' };
    return res.json({ ok: true, health: result });
  }

  try {
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
    const resp = await client.chat.completions.create({
      model:      process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      max_tokens: 5,
      messages:   [{ role: 'user', content: 'ping' }],
    });
    const used = resp.usage?.total_tokens ?? '?';
    result.groq = { status: 'ok', reason: `responded (${used} tokens)` };
  } catch (err) {
    result.groq = { status: 'dead', reason: err.message?.slice(0, 120) };
  }

  res.json({ ok: true, health: result });
});

module.exports = router;
