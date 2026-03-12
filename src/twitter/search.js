const { getClient } = require('./client');
const { upsertTweet, insertSnapshot, getTweetIdsForRefresh, recalculateGrowth } = require('../db/queries');

const SEARCH_QUERY  = process.env.SEARCH_QUERY || 'min_faves:15000 -is:retweet';
const HOURS_BACK    = parseInt(process.env.HOURS_BACK, 10) || 48;
const MAX_PAGES     = 5;          // 500 tweets max per run – keeps rate-limit usage sane
const PAGE_DELAY_MS = 1500;       // pause between paginated requests

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTweetRecord(tweet, usersById, mediaByKey) {
  const user    = usersById[tweet.author_id] || {};
  const metrics = tweet.public_metrics  || {};

  let hasMedia  = false;
  let mediaType = null;

  if (tweet.attachments?.media_keys?.length) {
    hasMedia = true;
    const first = mediaByKey[tweet.attachments.media_keys[0]];
    if (first) mediaType = first.type; // photo | video | animated_gif
  }

  return {
    tweet_id:      tweet.id,
    author_handle: user.username || '',
    author_name:   user.name     || '',
    tweet_text:    tweet.text    || '',
    likes:         metrics.like_count       || 0,
    retweets:      metrics.retweet_count    || 0,
    replies:       metrics.reply_count      || 0,
    views:         metrics.impression_count || 0,
    bookmarks:     metrics.bookmark_count   || 0,
    quotes:        metrics.quote_count      || 0,
    posted_at:     tweet.created_at         || null,
    tweet_url:     user.username
                     ? `https://x.com/${user.username}/status/${tweet.id}`
                     : null,
    has_media:  hasMedia,
    media_type: mediaType,
  };
}

// ─── Fetch new viral tweets via recent search ─────────────────────────────────
//
// Requires Elevated (or higher) access on the X Developer Portal because
// the min_faves: operator is only available at that access level.

async function fetchViralTweets() {
  const client    = getClient();
  const startTime = new Date(Date.now() - HOURS_BACK * 60 * 60 * 1000).toISOString();

  const baseParams = {
    'tweet.fields':  'public_metrics,author_id,created_at,text,attachments',
    'user.fields':   'username,name',
    'expansions':    'author_id,attachments.media_keys',
    'media.fields':  'type',
    'max_results':   100,
    'sort_order':    'recency',
    'start_time':    startTime,
  };

  let processed = 0;
  let nextToken  = undefined;
  let page       = 0;

  do {
    const params = nextToken ? { ...baseParams, next_token: nextToken } : baseParams;

    let response;
    try {
      response = await client.v2.search(SEARCH_QUERY, params);
    } catch (err) {
      // Handle rate-limit (429) gracefully – log and bail for this run
      if (err.code === 429 || err.rateLimit) {
        const resetAt = err.rateLimit?.reset
          ? new Date(err.rateLimit.reset * 1000).toISOString()
          : 'unknown';
        console.warn(`[Twitter] Rate limited. Resets at ${resetAt}. Stopping early.`);
        break;
      }
      throw err;
    }

    const tweets  = response.data?.data   || [];
    if (!tweets.length) break;

    // Build lookup maps from the includes
    const usersById  = {};
    const mediaByKey = {};

    for (const u of response.data?.includes?.users  || []) usersById[u.id]         = u;
    for (const m of response.data?.includes?.media  || []) mediaByKey[m.media_key] = m;

    for (const tweet of tweets) {
      const record = buildTweetRecord(tweet, usersById, mediaByKey);
      await upsertTweet(record);
      await insertSnapshot(tweet.id, tweet.public_metrics || {});
      processed++;
    }

    nextToken = response.data?.meta?.next_token;
    page++;

    if (nextToken && page < MAX_PAGES) {
      await sleep(PAGE_DELAY_MS);
    }
  } while (nextToken && page < MAX_PAGES);

  console.log(`[Twitter] fetchViralTweets → ${processed} tweets upserted`);
  return processed;
}

// ─── Refresh metrics for already-tracked tweets ───────────────────────────────
//
// Uses the batch tweet lookup endpoint (100 IDs per request).
// After updating raw metrics it calls recalculateGrowth() to recompute
// likes_per_hour / views_per_hour / status.

async function refreshTrackedTweets() {
  const client = getClient();
  const ids    = await getTweetIdsForRefresh();

  if (!ids.length) {
    console.log('[Twitter] refreshTrackedTweets → nothing to refresh');
    return 0;
  }

  const BATCH = 100;
  let updated = 0;

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);

    try {
      const response = await client.v2.tweets(batch, {
        'tweet.fields': 'public_metrics,author_id',
        'user.fields':  'username',
        'expansions':   'author_id',
      });

      const usersById = {};
      for (const u of response.includes?.users || []) usersById[u.id] = u;

      for (const tweet of response.data || []) {
        const metrics = tweet.public_metrics || {};
        const user    = usersById[tweet.author_id] || {};

        await upsertTweet({
          tweet_id:      tweet.id,
          author_handle: user.username || '',
          likes:         metrics.like_count       || 0,
          retweets:      metrics.retweet_count    || 0,
          replies:       metrics.reply_count      || 0,
          views:         metrics.impression_count || 0,
          bookmarks:     metrics.bookmark_count   || 0,
          quotes:        metrics.quote_count      || 0,
        });

        await insertSnapshot(tweet.id, metrics);
        updated++;
      }
    } catch (err) {
      if (err.code === 429 || err.rateLimit) {
        const resetAt = err.rateLimit?.reset
          ? new Date(err.rateLimit.reset * 1000).toISOString()
          : 'unknown';
        console.warn(`[Twitter] Rate limited during refresh. Resets at ${resetAt}.`);
        break;
      }
      console.error(`[Twitter] Batch refresh error (offset ${i}):`, err.message);
    }

    if (i + BATCH < ids.length) {
      await sleep(2000);
    }
  }

  // Now recompute growth rates in DB
  const recalced = await recalculateGrowth();
  console.log(`[Twitter] refreshTrackedTweets → ${updated} updated, ${recalced} growth rows recalculated`);
  return updated;
}

module.exports = { fetchViralTweets, refreshTrackedTweets };
