'use strict';

const { Router } = require('express');
const {
  getJobs, archiveJob, markFilled,
  getStats, getRoleStats, getSubspaceStats,
  getVipWatchlist, addToVipWatchlist, removeFromVipWatchlist,
  clearSeen, getSeenCount,
  addTrainingExample, getTrainingExamples, deleteTrainingExample,
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
// Archives the job AND auto-saves it as a negative training example so the
// classifier learns not to accept this kind of tweet in future.

router.patch('/jobs/:id/archive', async (req, res) => {
  try {
    const job = await archiveJob(req.params.id);
    if (job) {
      addTrainingExample({
        tweet_text:    job.tweet_text,
        author_bio:    job.author_bio,
        author_handle: job.author_handle,
        role_type:     job.role_type,
        subspace:      job.subspace,
        is_positive:   false,
        note:          'Auto-saved: user dismissed as not a real job',
      }).catch(err => console.error('[Training] failed to save negative example:', err.message));
    }
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
    const [stats, roles, subspaces, seenCount] = await Promise.all([
      getStats(), getRoleStats(), getSubspaceStats(), getSeenCount(),
    ]);
    res.json({
      ok: true,
      stats: {
        ...stats,
        seen_count: seenCount,
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

// ─── Training examples ────────────────────────────────────────────────────────
// GET  /api/training          — list all examples
// POST /api/training          — submit a confirmed positive example
// DELETE /api/training/:id    — remove an example

router.get('/training', async (req, res) => {
  try {
    const examples = await getTrainingExamples(50);
    res.json({ ok: true, count: examples.length, examples });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/training', async (req, res) => {
  const { tweet_text, author_bio, author_handle, role_type, subspace, note } = req.body || {};
  if (!tweet_text?.trim()) return res.status(400).json({ ok: false, error: 'tweet_text required' });
  try {
    const id = await addTrainingExample({
      tweet_text: tweet_text.trim(),
      author_bio:    (author_bio    || '').trim(),
      author_handle: (author_handle || '').trim(),
      role_type:  role_type  || null,
      subspace:   subspace   || null,
      is_positive: true,
      note:       note       || null,
    });
    console.log(`[Training] Positive example #${id} added by user`);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/training/:id', async (req, res) => {
  try {
    await deleteTrainingExample(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DELETE /api/admin/seen-tweets ────────────────────────────────────────────
// Clears the seen_tweets dedup table so all tweets get re-fetched and
// re-classified on the next cycle. Use when the classifier was broken
// (no API key, wrong key, etc.) and you want a clean slate.

router.delete('/admin/seen-tweets', async (req, res) => {
  try {
    await clearSeen();
    console.log('[Admin] seen_tweets table cleared');
    res.json({ ok: true, message: 'seen_tweets cleared — next fetch will reprocess all tweets' });
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
