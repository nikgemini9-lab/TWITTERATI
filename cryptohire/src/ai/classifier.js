'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config    = require('../config');

const ROLE_TYPES  = ['engineer', 'researcher', 'trader', 'analyst', 'marketing', 'ops', 'design', 'bd', 'content', 'other'];
const SUBSPACES   = ['prediction_markets', 'defi', 'trading', 'nft', 'infrastructure', 'general_web3', 'other'];
const SENIORITIES = ['junior', 'mid', 'senior', 'lead', 'any'];
const CONTACTS    = ['dm', 'email', 'link', 'apply'];

const ROLE_SET     = new Set(ROLE_TYPES);
const SUBSPACE_SET = new Set(SUBSPACES);

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.warn('[AI] ANTHROPIC_API_KEY not set — classification disabled');
}

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: API_KEY });
  return _client;
}

// ─── System prompt ────────────────────────────────────────────────────────────
//
// The key insight: we pass BOTH the tweet text AND the author's bio.
// A tweet saying "hiring someone chronically online dm me" tells us nothing —
// but if the bio says "building prediction markets" it's an obvious match.

const SYSTEM_PROMPT = `You are a classifier that identifies crypto/web3 job postings from tweets.

You will receive tweets (possibly with no crypto keywords) along with the author's Twitter bio.
Use BOTH pieces of information to determine if this is a hiring post from someone in the crypto/web3 space.

Crypto/web3 space includes:
- Prediction markets (Polymarket, Manifold, Kalshi, etc.)
- DeFi protocols, DEXs, lending, yield, stablecoins
- Trading firms, market makers, prop shops, quant funds active in crypto
- Blockchain infrastructure (L1s, L2s, bridges, wallets, nodes)
- NFT projects and marketplaces
- General crypto/web3 startups and DAOs
- Crypto-focused VCs and accelerators

Role types: engineer, researcher, trader, analyst, marketing, ops, design, bd, content, other
Subspaces: prediction_markets, defi, trading, nft, infrastructure, general_web3, other
Seniorities: junior, mid, senior, lead, any
Contact methods: dm, email, link, apply

Rules:
- is_crypto_hiring: true ONLY if this is a genuine job posting from a crypto/web3 entity
- Use author bio heavily — a vague tweet from a known crypto person IS crypto hiring
- Confidence: 0.0–1.0. Be conservative. If unsure, give 0.5 or lower.
- ai_summary: one concise sentence describing the role (e.g. "Prediction markets startup hiring a mid-level researcher, remote, DM to apply")
- Reply ONLY with a valid JSON array. No markdown, no explanation.

Format: [{"tweet_id":"...","is_crypto_hiring":bool,"confidence":0.0,"role_type":"...","subspace":"...","remote":bool|null,"seniority":"..."|null,"contact_method":"..."|null,"ai_summary":"..."}]`;

// ─── Batch classify ───────────────────────────────────────────────────────────

const BATCH_SIZE = 20; // keep prompt size reasonable

async function classifyBatch(candidates) {
  if (!API_KEY || !candidates.length) return [];

  const results = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const chunk = await classifyChunk(batch);
    results.push(...chunk);
  }

  return results;
}

async function classifyChunk(candidates) {
  const list = candidates
    .map((c, idx) => {
      const bio = (c.author_bio || '').slice(0, 160);
      const txt = (c.tweet_text || '').slice(0, 280);
      return `${idx + 1}. [ID:${c.tweet_id}]\n   Bio: ${bio || '(no bio)'}\n   Tweet: ${txt}`;
    })
    .join('\n\n');

  const userMessage = `Classify these tweets:\n\n${list}`;

  let raw;
  try {
    const response = await getClient().messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    });
    raw = response.content[0]?.text?.trim() || '[]';
  } catch (err) {
    console.error('[AI] Claude API error:', err.message);
    return [];
  }

  let parsed;
  try {
    const clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error('[AI] Failed to parse response:', raw.slice(0, 200));
    return [];
  }

  // Build a map of tweet_id → candidate for quick lookup
  const candidateMap = new Map(candidates.map((c) => [c.tweet_id, c]));

  const jobs = [];
  for (const entry of parsed) {
    if (!entry?.tweet_id) continue;
    if (!entry.is_crypto_hiring) continue;
    if ((entry.confidence ?? 0) < config.minConfidence) continue;

    const candidate = candidateMap.get(String(entry.tweet_id));
    if (!candidate) continue;

    jobs.push({
      ...candidate,
      role_type:      ROLE_SET.has(entry.role_type)     ? entry.role_type     : 'other',
      subspace:       SUBSPACE_SET.has(entry.subspace)  ? entry.subspace      : 'general_web3',
      remote:         entry.remote ?? null,
      seniority:      entry.seniority || null,
      contact_method: entry.contact_method || null,
      ai_summary:     entry.ai_summary || null,
      confidence:     entry.confidence,
    });
  }

  console.log(`[AI] chunk of ${candidates.length} → ${jobs.length} crypto jobs (threshold ${config.minConfidence})`);
  return jobs;
}

module.exports = { classifyBatch };
