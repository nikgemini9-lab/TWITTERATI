const { getClient } = require('./client');
const { upsertTweet, insertSnapshot, getTweetIdsForRefresh, recalculateGrowth, getUnclassifiedTweets, bulkSetTopics, getVipWatchlist, setVipUserId } = require('../db/queries');
const { batchClassifyTweets } = require('../ai/classifier');
const config = require('../config');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function classifyNewTweets() {
  const tweets = await getUnclassifiedTweets(50);
  if (!tweets.length) return;
  console.log(`[AI] Classifying ${tweets.length} unclassified tweets…`);
  const results = await batchClassifyTweets(tweets);
  if (results.length) {
    await bulkSetTopics(results);
    console.log(`[AI] Topics set for ${results.length} tweets`);
  }
}

// Map a Rettiwt Tweet object → our DB record shape
function tweetToRecord(tweet) {
  const user      = tweet.tweetBy || {};
  const mediaList = tweet.media   || [];

  const hasMedia  = mediaList.length > 0;
  // MediaType enum values: 'Photo' | 'Video' | 'Gif'  (capitalised in rettiwt-api)
  const mediaType = hasMedia ? mediaList[0].type?.toLowerCase() : null;
  // For photos use .url directly; for video/gif use .thumbnailUrl as preview
  const mediaUrl  = hasMedia
    ? (mediaList[0].thumbnailUrl || mediaList[0].url || null)
    : null;

  return {
    tweet_id:      tweet.id,
    author_handle: user.userName  || '',
    author_name:   user.fullName  || '',
    tweet_text:    tweet.fullText || '',
    likes:         tweet.likeCount     || 0,
    retweets:      tweet.retweetCount  || 0,
    replies:       tweet.replyCount    || 0,
    views:         tweet.viewCount     || 0,
    bookmarks:     tweet.bookmarkCount || 0,
    quotes:        tweet.quoteCount    || 0,
    posted_at:     tweet.createdAt     || null,
    tweet_url:     tweet.url
                     || (user.userName
                           ? `https://x.com/${user.userName}/status/${tweet.id}`
                           : null),
    has_media:  hasMedia,
    media_type: mediaType,
    media_url:  mediaUrl,
  };
}

// Normalise a Rettiwt Tweet into the metrics shape expected by insertSnapshot
function tweetToMetrics(tweet) {
  return {
    like_count:       tweet.likeCount     || 0,
    retweet_count:    tweet.retweetCount  || 0,
    reply_count:      tweet.replyCount    || 0,
    impression_count: tweet.viewCount     || 0,
    bookmark_count:   tweet.bookmarkCount || 0,
  };
}

// ─── Fetch new viral tweets via search ───────────────────────────────────────
//
// Simple: min_faves:X -filter:replies — identical to a manual Twitter search.
// No since: filter. Twitter returns results by recency/engagement and the same
// query run every 10 minutes naturally catches everything that crosses the
// threshold. ON CONFLICT handles duplicates gracefully.

async function fetchViralTweets() {
  const client = getClient();

  const filter = {
    minLikes:     config.minLikes,
    onlyOriginal: true,
    ...(config.minRetweets > 0 && { minRetweets: config.minRetweets }),
  };

  console.log(`[Twitter] fetch: min_faves:${config.minLikes} -filter:replies`);

  let processed = 0;
  let cursor    = undefined;
  let page      = 0;

  do {
    let result;
    try {
      result = await client.tweet.search(filter, 20, cursor);
    } catch (err) {
      console.error(`[Twitter] search error (page ${page}):`, err.message ?? err);
      break;
    }

    const tweets = result?.list ?? [];
    if (!tweets.length) break;

    for (const tweet of tweets) {
      await upsertTweet(tweetToRecord(tweet));
      await insertSnapshot(tweet.id, tweetToMetrics(tweet));
      processed++;
    }

    cursor = result?.next?.value;
    page++;
    if (cursor) await sleep(2000);
  } while (cursor && page < 3); // 3 pages = 60 tweets per cycle — conservative to avoid rate limits

  console.log(`[Twitter] fetchViralTweets → ${processed} tweets upserted (${page} pages)`);
  classifyNewTweets().catch(err => console.error('[AI] classifyNewTweets error:', err.message));
  return processed;
}

// ─── Refresh metrics for already-tracked tweets ───────────────────────────────
//
// rettiwt.tweet.details(string[]) accepts an array of IDs and returns Tweet[].
// We process in batches to avoid overloading a single call.

async function refreshTrackedTweets() {
  const client = getClient();
  const ids    = await getTweetIdsForRefresh();

  if (!ids.length) {
    console.log('[Twitter] refreshTrackedTweets → nothing to refresh');
    return 0;
  }

  // Rettiwt bulk details: the library handles multiple IDs but we keep batches
  // small to avoid timeouts and stay polite.
  const BATCH = 20;
  let updated = 0;

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);

    try {
      const tweets = await client.tweet.details(batch); // returns Tweet[]

      for (const tweet of tweets ?? []) {
        if (!tweet) continue;
        const record  = tweetToRecord(tweet);
        const metrics = tweetToMetrics(tweet);
        await upsertTweet(record);
        await insertSnapshot(tweet.id, metrics);
        updated++;
      }
    } catch (err) {
      console.error(`[Twitter] details batch error (offset ${i}):`, err.message ?? err);
    }

    if (i + BATCH < ids.length) {
      await sleep(1500);
    }
  }

  // Recompute growth rates + parabolic status in DB
  const recalced = await recalculateGrowth();
  console.log(`[Twitter] refreshTrackedTweets → ${updated} updated, ${recalced} growth rows recalculated`);
  classifyNewTweets().catch(err => console.error('[AI] classifyNewTweets error:', err.message));
  return updated;
}

// ─── Deep backfill pass ───────────────────────────────────────────────────────
//
// Runs once daily. Looks back 48 hours to catch any viral tweet that:
//  - crossed the like threshold slowly (after the 12h window had moved on)
//  - was missed due to API gaps or transient rate limiting
// Uses a higher like threshold to keep the result set small.

async function deepBackfill() {
  const client    = getClient();
  const startDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const minLikes  = Math.max(config.minLikes, 30000); // higher bar to limit results

  const filter = {
    minLikes,
    onlyOriginal: true,
    startDate,
  };

  console.log(`[Twitter] deepBackfill: min_faves:${minLikes} since:${startDate.toISOString()}`);

  let processed = 0;
  let cursor    = undefined;
  let page      = 0;

  do {
    let result;
    try {
      result = await client.tweet.search(filter, 20, cursor);
    } catch (err) {
      console.error(`[Twitter] deepBackfill search error (page ${page}):`, err.message ?? err);
      break;
    }

    const tweets = result?.list ?? [];
    if (!tweets.length) break;

    for (const tweet of tweets) {
      const record  = tweetToRecord(tweet);
      const metrics = tweetToMetrics(tweet);
      await upsertTweet(record);
      await insertSnapshot(tweet.id, metrics);
      processed++;
    }

    cursor = result?.next?.value;
    page++;
    if (cursor) await sleep(2000);
  } while (cursor);

  console.log(`[Twitter] deepBackfill → ${processed} tweets upserted (${page} pages)`);
  return processed;
}

// ─── Poll VIP account timelines ───────────────────────────────────────────────
//
// For each account in the vip_watchlist, fetch the last 20 tweets directly
// from their timeline. This bypasses the search filter entirely — no minLikes,
// no 45-min window, no language filter. Any tweet posted since last seen is
// upserted so it can start accumulating growth snapshots immediately.

async function fetchVipTimelines() {
  const client = getClient();
  const vips   = await getVipWatchlist();
  if (!vips.length) return 0;

  let processed = 0;

  for (const vip of vips) {
    let userId = vip.user_id;

    // Resolve handle → numeric ID on first encounter (cached in DB)
    if (!userId) {
      try {
        const user = await client.user.details(vip.handle);
        if (!user?.id) {
          console.warn(`[VIP] Cannot resolve user ID for @${vip.handle} — skipping`);
          await sleep(500);
          continue;
        }
        userId = user.id;
        await setVipUserId(vip.handle, userId);
        console.log(`[VIP] Resolved @${vip.handle} → ${userId}`);
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
        const record  = tweetToRecord(tweet);
        const metrics = tweetToMetrics(tweet);
        await upsertTweet(record);
        await insertSnapshot(tweet.id, metrics);
        processed++;
      }
      console.log(`[VIP] @${vip.handle}: ${tweets.length} tweets upserted`);
    } catch (err) {
      console.error(`[VIP] timeline error for @${vip.handle}:`, err.message ?? err);
    }

    await sleep(800);
  }

  return processed;
}

module.exports = { fetchViralTweets, refreshTrackedTweets, fetchVipTimelines, deepBackfill };
