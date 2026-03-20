'use strict';

const { getClient }     = require('./client');
const { markSeen, filterUnseen, upsertJob, getVipWatchlist, setVipUserId } = require('../db/queries');
const { classifyBatch } = require('../ai/classifier');
const config            = require('../config');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Search query pool ────────────────────────────────────────────────────────
//
// Multiple queries to cast a wide net. None of these use crypto keywords —
// that's the whole point. The AI classifier + author bio do the heavy lifting.
//
// We run all queries every cycle and dedup by tweet_id via the seen_tweets
// table, so processing each tweet exactly once.

// Simple natural-language queries — Twitter handles these perfectly.
// No complex boolean chains, no parentheses groups.
// Every query has both a hiring signal AND a crypto signal baked in.

const QUERIES = [
  // 2-keyword combos — Twitter must find BOTH words anywhere in the tweet.
  // Simple = more results. Pre-filter + AI do the quality control.
  'crypto hiring -filter:replies',
  'web3 hiring -filter:replies',
  'defi hiring -filter:replies',
  'blockchain hiring -filter:replies',
  'solana hiring -filter:replies',
  'ethereum hiring -filter:replies',
  'nft hiring -filter:replies',
  'dao hiring -filter:replies',
  'crypto "open role" -filter:replies',
  'web3 "open role" -filter:replies',
  'crypto "open position" -filter:replies',
  'web3 "open position" -filter:replies',
  'crypto "looking for" -filter:replies',
  'web3 "looking for" -filter:replies',
  'solana "looking for" -filter:replies',
];

// ─── Parse a rettiwt Tweet into our raw job candidate shape ──────────────────

function tweetToCandidate(tweet) {
  const user = tweet.tweetBy || {};
  return {
    tweet_id:         tweet.id,
    author_handle:    user.userName        || '',
    author_name:      user.fullName        || '',
    author_bio:       user.description     || '',
    author_followers: user.followersCount  || 0,
    author_verified:  !!(user.isVerified || user.isBlueVerified),
    tweet_text:       tweet.fullText       || '',
    likes:            tweet.likeCount      || 0,
    retweets:         tweet.retweetCount   || 0,
    replies:          tweet.replyCount     || 0,
    views:            tweet.viewCount      || 0,
    posted_at:        tweet.createdAt      || null,
    tweet_url:        tweet.url
                        || (user.userName
                              ? `https://x.com/${user.userName}/status/${tweet.id}`
                              : null),
  };
}

// ─── Hard pre-filter ──────────────────────────────────────────────────────────
// Twitter's search is fuzzy — it matches across bios, names, and handles,
// not just tweet text. This means a tweet like "FREE $SOL in your wallet"
// can appear in a "hiring" search if the author's bio mentions hiring.
// We reject anything that doesn't contain at least one hiring keyword in
// the actual tweet text. This happens before the AI ever sees the tweet.

const HIRING_TERMS = [
  'hiring', 'hire', 'we\'re hiring', 'now hiring',
  'looking for', 'open role', 'open position',
  'we are hiring', 'join our team', 'join us',
  'apply now', 'apply here', 'apply at', 'applications open',
  'seeking a', 'seeking an', 'we need a', 'we need an',
  'dm to apply', 'send your cv', 'send cv', 'send resume',
  'job opening', 'job opportunity', 'work with us',
  'onboarding', 'new role', 'full-time', 'part-time', 'contract role',
];

function looksLikeHiring(text) {
  const lower = (text || '').toLowerCase();
  return HIRING_TERMS.some((t) => lower.includes(t));
}

// ─── Run a single search query, return unseen candidates ─────────────────────

async function runQuery(client, queryString, label) {
  const filter = {
    keyword:      queryString,
    minLikes:     config.minLikes,
    onlyOriginal: true,
  };

  let candidates = [];
  let cursor     = undefined;
  let page       = 0;

  do {
    let result;
    try {
      result = await client.tweet.search(filter, 20, cursor);
    } catch (err) {
      console.error(`[Twitter] query "${label}" error (page ${page}):`, err.message ?? err);
      break;
    }

    const tweets = result?.list ?? [];
    if (!tweets.length) break;

    let kept = 0, dropped = 0;
    for (const tweet of tweets) {
      if (!looksLikeHiring(tweet.fullText)) { dropped++; continue; }
      candidates.push(tweetToCandidate(tweet));
      kept++;
    }
    if (dropped) console.log(`[Twitter] "${label}" pre-filter: kept ${kept}, dropped ${dropped} (no hiring keyword in text)`);

    cursor = result?.next?.value;
    page++;
    if (cursor) await sleep(500);
  } while (cursor && page < 5); // 5 pages × 20 = 100 per query

  console.log(`[Twitter] "${label}" → ${candidates.length} candidates (${page} pages)`);
  return candidates;
}

// ─── Main fetch cycle ─────────────────────────────────────────────────────────
//
// Runs all queries, deduplicates, filters against seen_tweets,
// sends fresh candidates to the AI classifier, stores confirmed jobs.

async function fetchHiringTweets() {
  const client = getClient();

  // Collect candidates from all queries, dedup by tweet_id
  const seen    = new Map();
  let   fetched = 0;

  for (const q of QUERIES) {
    const label      = q.slice(0, 40);
    const candidates = await runQuery(client, q, label);
    for (const c of candidates) {
      if (!seen.has(c.tweet_id)) seen.set(c.tweet_id, c);
    }
    fetched += candidates.length;
    await sleep(1000); // be polite between queries
  }

  const allCandidates  = [...seen.values()];
  const allIds         = allCandidates.map((c) => c.tweet_id);

  // Filter out tweets we've already processed
  const unseenIds      = await filterUnseen(allIds);
  const fresh          = allCandidates.filter((c) => unseenIds.includes(c.tweet_id));

  console.log(`[Twitter] ${fetched} fetched → ${allCandidates.length} deduped → ${fresh.length} new`);

  // Mark all as seen immediately to avoid re-processing on errors
  await markSeen(allIds);

  if (!fresh.length) return 0;

  // Classify in batches (the classifier handles batching internally)
  const jobs = await classifyBatch(fresh);

  // Store confirmed jobs
  let stored = 0;
  for (const job of jobs) {
    await upsertJob(job);
    stored++;
  }

  console.log(`[Crawler] ${fresh.length} classified → ${stored} crypto jobs stored`);
  return stored;
}

// ─── VIP timeline polling ─────────────────────────────────────────────────────
//
// For known crypto firms/people: poll their timeline directly so we catch
// hiring posts even if they fall below the minLikes threshold.

async function fetchVipTimelines() {
  const client = getClient();
  const vips   = await getVipWatchlist();
  if (!vips.length) return 0;

  let candidates = [];

  for (const vip of vips) {
    let userId = vip.user_id;

    if (!userId) {
      try {
        const user = await client.user.details(vip.handle);
        if (!user?.id) {
          console.warn(`[VIP] Cannot resolve @${vip.handle} — skipping`);
          await sleep(500);
          continue;
        }
        userId = user.id;
        await setVipUserId(vip.handle, userId);
      } catch (err) {
        console.error(`[VIP] user.details error for @${vip.handle}:`, err.message ?? err);
        await sleep(500);
        continue;
      }
    }

    try {
      const result = await client.user.timeline(userId, 20);
      const tweets = result?.list ?? [];

      for (const tweet of tweets) {
        if (!tweet) continue;
        const c = tweetToCandidate(tweet);
        // Inject known bio from handle if bio missing in timeline result
        if (!c.author_bio) c.author_bio = `VIP account: @${vip.handle}`;
        candidates.push(c);
      }
      console.log(`[VIP] @${vip.handle}: ${tweets.length} tweets fetched`);
    } catch (err) {
      console.error(`[VIP] timeline error for @${vip.handle}:`, err.message ?? err);
    }

    await sleep(800);
  }

  if (!candidates.length) return 0;

  const allIds    = candidates.map((c) => c.tweet_id);
  const unseenIds = await filterUnseen(allIds);
  const fresh     = candidates.filter((c) => unseenIds.includes(c.tweet_id));

  await markSeen(allIds);

  if (!fresh.length) return 0;

  const jobs = await classifyBatch(fresh);
  let stored = 0;
  for (const job of jobs) {
    await upsertJob(job);
    stored++;
  }

  console.log(`[VIP] ${fresh.length} new tweets → ${stored} crypto jobs stored`);
  return stored;
}

module.exports = { fetchHiringTweets, fetchVipTimelines };
