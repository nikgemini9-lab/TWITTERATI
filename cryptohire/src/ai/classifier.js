'use strict';

const OpenAI = require('openai');
const config = require('../config');
const { getTrainingExamples } = require('../db/queries');

const ROLE_TYPES    = ['engineer', 'researcher', 'trader', 'analyst', 'marketing', 'ops', 'design', 'bd', 'content', 'other'];
const SUBSPACES     = ['prediction_markets', 'defi', 'trading', 'nft', 'infrastructure', 'general_web3', 'other'];
const POSTER_TYPES  = ['founder', 'hiring_manager', 'recruiter', 'employee', 'unknown'];

const ROLE_SET        = new Set(ROLE_TYPES);
const SUBSPACE_SET    = new Set(SUBSPACES);
const POSTER_TYPE_SET = new Set(POSTER_TYPES);

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

// llama-3.3-70b-versatile — smarter, still free tier on Groq, much fewer hallucinations
// Override with GROQ_MODEL env var if needed (e.g. llama-3.1-8b-instant for speed)
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// ─── System prompt ────────────────────────────────────────────────────────────
//
// The key insight: we pass BOTH the tweet text AND the author's bio.
// A tweet saying "hiring someone chronically online dm me" tells us nothing —
// but if the bio says "building prediction markets" it's an obvious match.

const SYSTEM_PROMPT = `You are an elite Web3 talent scout. Your job is to find ONLY the highest-quality, most legitimate crypto/web3 job opportunities from tweets.

You receive each tweet's text and the author's Twitter bio. Analyse BOTH carefully.

━━━ STEP 1: REJECT IMMEDIATELY (set is_crypto_hiring: false, quality_score: 0) ━━━

Reject if ANY of these apply:
• Tweet contains: "airdrop", "bounty", "giveaway", "whitelist", "ambassador program", "shill", "raid", "meme coin", "memecoin", "referral"
• Author bio is about: sports, football, FPL, fantasy sports, betting tipster, general stocks/forex (no crypto mention)
• Tweet is promotional/marketing content, not an actual job posting
• Tweet is engagement bait ("reply guys always win", "let's network", "late night connections")
• No actual role is described — just vibes ("DM me", "opportunities available", "join our community")
• Non-English tweet with no crypto/web3 signals
• General-purpose SaaS/fintech with no blockchain focus

━━━ STEP 2: CLASSIFY POSTER TYPE ━━━

Determine poster_type from bio + tweet tone:
• "founder"         → Founder/Co-founder/CEO building the protocol or company
• "hiring_manager"  → Head of X, VP, Director, or team lead hiring for their team
• "recruiter"       → Explicitly a recruiter, talent partner, headhunter, or talent scout
• "employee"        → Engineer/contributor at a company posting on behalf of their team
• "unknown"         → Can't determine from available info

━━━ STEP 3: SCORE QUALITY (1–10) ━━━

Score based on these weighted factors:

POSTER CREDIBILITY (0–3 pts):
  3 pts → Founder/Co-founder hiring directly
  2 pts → Hiring manager or senior team member
  1 pt  → Recruiter with named company/project
  0 pts → Unknown account, no verifiable affiliation

COMPANY/PROJECT QUALITY (0–2 pts):
  2 pts → Named funded project (mentions raise, backed, seed, Series A/B, known ecosystem team)
  1 pt  → Named project with some web3 presence
  0 pts → Anonymous, unnamed, or purely speculative

JOB CLARITY (0–3 pts):
  3 pts → Clear role title + required skills + salary/equity or apply link
  2 pts → Clear role title + skills (no link/salary)
  1 pt  → General role title, few details
  0 pts → Vague ("hiring engineers", no specifics)

SIGNAL CLEANLINESS (0–2 pts):
  2 pts → Professional, specific, no engagement farming
  1 pt  → Mostly clean but has some "RT to spread" or vague CTA
  0 pts → Spammy, "gm" crowd, no signal

MINIMUM THRESHOLD: quality_score must be ≥ 7 for is_crypto_hiring: true.
Anything scored 1–6 → is_crypto_hiring: false.

━━━ STEP 4: EXTRACT STRUCTURED DATA ━━━

For each accepted job (quality_score ≥ 7) extract:
• role_title   → Specific title e.g. "Senior Solidity Engineer", "DeFi Protocol Growth Lead"
• company      → Company or project name (null if not mentioned)
• skills       → Comma-separated key skills mentioned e.g. "Solidity, EVM, Foundry, DeFi"
• location     → "Remote", "On-site: [City]", "Hybrid: [City]", or null
• contact_method → dm | email | link | apply

━━━ VALID VALUES ━━━

role_type: engineer | researcher | trader | analyst | marketing | ops | design | bd | content | other
subspace: prediction_markets | defi | trading | nft | infrastructure | general_web3 | other
seniority: junior | mid | senior | lead | any
poster_type: founder | hiring_manager | recruiter | employee | unknown

━━━ OUTPUT FORMAT ━━━

Reply ONLY with a valid JSON array. No markdown, no explanation, no code fences.

[{
  "tweet_id": "...",
  "is_crypto_hiring": bool,
  "confidence": 0.0,
  "quality_score": 0,
  "poster_type": "...",
  "role_title": "...",
  "company": "...",
  "role_type": "...",
  "subspace": "...",
  "remote": bool|null,
  "seniority": "..."|null,
  "contact_method": "..."|null,
  "skills": "...",
  "ai_summary": "one sentence: who is hiring, what role, key skills, location, how to apply"
}]`;

// ─── Batch classify ───────────────────────────────────────────────────────────

const BATCH_SIZE = 15;

// Build the few-shot block from stored training examples.
// Positive examples show what a real job looks like.
// Negative examples (is_positive=0) show what to reject.
function buildFewShotBlock(examples) {
  if (!examples.length) return '';

  const lines = ['', 'CALIBRATION EXAMPLES (use these to set your judgment bar):', ''];

  const pos = examples.filter((e) => e.is_positive);
  const neg = examples.filter((e) => !e.is_positive);

  if (pos.length) {
    lines.push('✅ REAL crypto job posts (is_crypto_hiring: true):');
    for (const e of pos.slice(0, 5)) {
      lines.push(`  Bio: ${(e.author_bio || '(none)').slice(0, 120)}`);
      lines.push(`  Tweet: ${(e.tweet_text || '').slice(0, 200)}`);
      if (e.role_type) lines.push(`  → role_type: ${e.role_type}, subspace: ${e.subspace || 'general_web3'}`);
      lines.push('');
    }
  }

  if (neg.length) {
    lines.push('❌ NOT job posts — dismissed as trash (is_crypto_hiring: false):');
    for (const e of neg.slice(0, 5)) {
      lines.push(`  Bio: ${(e.author_bio || '(none)').slice(0, 120)}`);
      lines.push(`  Tweet: ${(e.tweet_text || '').slice(0, 200)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function classifyBatch(candidates) {
  if (!API_KEY || !candidates.length) return [];

  // Load recent training examples once per batch run
  let examples = [];
  try {
    examples = await getTrainingExamples(20);
  } catch (err) {
    console.warn('[AI] Could not load training examples:', err.message);
  }

  const fewShot = buildFewShotBlock(examples);

  const results = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const chunk = await classifyChunk(batch, fewShot);
    results.push(...chunk);
  }

  return results;
}

async function classifyChunk(candidates, fewShot = '') {
  const list = candidates
    .map((c, idx) => {
      const bio = (c.author_bio || '').slice(0, 160);
      const txt = (c.tweet_text || '').slice(0, 280);
      return `${idx + 1}. [ID:${c.tweet_id}]\n   Bio: ${bio || '(no bio)'}\n   Tweet: ${txt}`;
    })
    .join('\n\n');

  let raw;
  try {
    const systemContent = fewShot ? `${SYSTEM_PROMPT}\n${fewShot}` : SYSTEM_PROMPT;
    const response = await getClient().chat.completions.create({
      model:       MODEL,
      max_tokens:  2048,
      temperature: 0,
      messages: [
        { role: 'system', content: systemContent },
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
    // Enforce quality gate — anything below 7 is noise regardless of confidence
    if ((entry.quality_score ?? 0) < 7) continue;

    const candidate = candidateMap.get(String(entry.tweet_id));
    if (!candidate) continue;

    jobs.push({
      ...candidate,
      role_type:      ROLE_SET.has(entry.role_type)          ? entry.role_type    : 'other',
      subspace:       SUBSPACE_SET.has(entry.subspace)       ? entry.subspace     : 'general_web3',
      poster_type:    POSTER_TYPE_SET.has(entry.poster_type) ? entry.poster_type  : 'unknown',
      remote:         entry.remote ?? null,
      seniority:      entry.seniority || null,
      contact_method: entry.contact_method || null,
      ai_summary:     entry.ai_summary || null,
      confidence:     entry.confidence,
      quality_score:  entry.quality_score ?? null,
      role_title:     entry.role_title || null,
      company:        entry.company || null,
      skills:         entry.skills || null,
    });
  }

  console.log(`[AI] chunk of ${candidates.length} → ${jobs.length} crypto jobs (model: ${MODEL})`);
  return jobs;
}

module.exports = { classifyBatch };
