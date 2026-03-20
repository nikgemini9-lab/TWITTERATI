'use strict';

const OpenAI = require('openai');
const config = require('../config');

const ROLE_TYPES  = ['engineer', 'researcher', 'trader', 'analyst', 'marketing', 'ops', 'design', 'bd', 'content', 'other'];
const SUBSPACES   = ['prediction_markets', 'defi', 'trading', 'nft', 'infrastructure', 'general_web3', 'other'];

const ROLE_SET     = new Set(ROLE_TYPES);
const SUBSPACE_SET = new Set(SUBSPACES);

const API_KEY = process.env.GROQ_API_KEY;
if (!API_KEY) {
  console.warn('[AI] GROQ_API_KEY not set — classification disabled');
}

// Groq exposes an OpenAI-compatible API — just point the base URL at their endpoint.
// Free tier: https://console.groq.com  (no credit card required)
let _client = null;
function getClient() {
  if (!_client) {
    _client = new OpenAI({
      apiKey:  API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return _client;
}

// llama-3.1-8b-instant — fast, free tier, good at structured JSON output
// Fallback: llama-3.3-70b-versatile (slower but smarter, also free tier)
const MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

// ─── System prompt ────────────────────────────────────────────────────────────
//
// The key insight: we pass BOTH the tweet text AND the author's bio.
// A tweet saying "hiring someone chronically online dm me" tells us nothing —
// but if the bio says "building prediction markets" it's an obvious match.

const SYSTEM_PROMPT = `You are a strict classifier that identifies crypto/web3 job postings from tweets.

You will receive tweets (possibly with no crypto keywords) along with the author's Twitter bio.
Use BOTH pieces of information to determine if this is a hiring post from someone in the crypto/web3 space.

Crypto/web3 space INCLUDES:
- Prediction markets (Polymarket, Manifold, Kalshi, etc.)
- DeFi protocols, DEXs, lending, yield, stablecoins
- Trading firms/funds/market makers with explicit crypto/blockchain focus
- Blockchain infrastructure (L1s, L2s, bridges, wallets, nodes)
- NFT projects and marketplaces
- General crypto/web3 startups and DAOs
- Crypto-focused VCs and accelerators
- Web3 marketing, community management, social media, content, growth roles at crypto companies

HARD REJECTIONS — set is_crypto_hiring: false if:
- The author or bio is about sports (football, soccer, basketball, baseball, FPL, fantasy sports, tipsters, betting)
- The author or bio is about general finance/stocks/forex with no crypto/blockchain mention
- The tweet is in a non-English language and shows no crypto/blockchain signals
- The platform is a general-purpose trading tool (e.g. TrendSpider, TradingView) with no stated crypto focus
- The role is at a sports analytics, e-sports, or gambling company (not blockchain-based)
- The tweet is promotional/marketing content, not an actual job post
- Confidence would be below 0.80

Role types: engineer, researcher, trader, analyst, marketing, ops, design, bd, content, other
Subspaces: prediction_markets, defi, trading, nft, infrastructure, general_web3, other
Seniorities: junior, mid, senior, lead, any
Contact methods: dm, email, link, apply

Rules:
- is_crypto_hiring: true ONLY if this is a genuine job posting from a confirmed crypto/web3 entity
- Use author bio as primary signal — if bio has no crypto/blockchain/web3/DeFi/NFT/DAO keywords, be very skeptical
- Confidence: 0.0–1.0. Be conservative. Anything below 0.80 should be false.
- ai_summary: one concise sentence (e.g. "DeFi protocol hiring a senior smart contract engineer, remote, apply via link")
- Reply ONLY with a valid JSON array. No markdown, no explanation, no code fences.

Format: [{"tweet_id":"...","is_crypto_hiring":bool,"confidence":0.0,"role_type":"...","subspace":"...","remote":bool|null,"seniority":"..."|null,"contact_method":"..."|null,"ai_summary":"..."}]`;

// ─── Batch classify ───────────────────────────────────────────────────────────

const BATCH_SIZE = 15; // slightly smaller than before — 8B model has shorter context

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

  let raw;
  try {
    const response = await getClient().chat.completions.create({
      model:       MODEL,
      max_tokens:  2048,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Classify these tweets:\n\n${list}` },
      ],
    });
    raw = response.choices[0]?.message?.content?.trim() || '[]';
  } catch (err) {
    console.error('[AI] Groq API error:', err.message);
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
      role_type:      ROLE_SET.has(entry.role_type)    ? entry.role_type    : 'other',
      subspace:       SUBSPACE_SET.has(entry.subspace) ? entry.subspace     : 'general_web3',
      remote:         entry.remote ?? null,
      seniority:      entry.seniority || null,
      contact_method: entry.contact_method || null,
      ai_summary:     entry.ai_summary || null,
      confidence:     entry.confidence,
    });
  }

  console.log(`[AI] chunk of ${candidates.length} → ${jobs.length} crypto jobs (model: ${MODEL})`);
  return jobs;
}

module.exports = { classifyBatch };
