const { getClient } = require('./client');
const { upsertTweet, insertSnapshot, getTweetIdsForRefresh, recalculateGrowth } = require('../db/queries');

const MIN_LIKES   = parseInt(process.env.MIN_LIKES, 10)  || 200;  // cast wide net early
const HOURS_BACK  = parseInt(process.env.HOURS_BACK, 10) || 2;    // 2-hour window to catch acceleration
const MAX_PAGES   = parseInt(process.env.MAX_PAGES, 10)  || 15;   // 15 × 20 = 300 tweets max

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Map a Rettiwt Tweet object → our DB record shape
function tweetToRecord(tweet) {
  const user      = tweet.tweetBy || {};
  const mediaList = tweet.media   || [];

  const hasMedia  = mediaList.length > 0;
  // MediaType enum values: 'Photo' | 'Video' | 'Gif'  (capitalised in rettiwt-api)
  const mediaType = hasMedia ? mediaList[0].type?.toLowerCase() : null;

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
// Uses ITweetFilter.minLikes + startDate to hit Twitter Advanced Search.
// Rettiwt returns at most 20 tweets per call; we paginate up to MAX_PAGES.

async function fetchViralTweets() {
  const client    = getClient();
  const startDate = new Date(Date.now() - HOURS_BACK * 60 * 60 * 1000);

  const filter = {
    minLikes:     MIN_LIKES,
    startDate,
    onlyOriginal: true,   // exclude retweets
  };

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
      const record  = tweetToRecord(tweet);
      const metrics = tweetToMetrics(tweet);
      await upsertTweet(record);
      await insertSnapshot(tweet.id, metrics);
      processed++;
    }

    cursor = result?.next?.value;
    page++;

    // Polite delay between pages (client-level delay already applied per-request,
    // but an extra pause between pages reduces hammering)
    if (cursor && page < MAX_PAGES) {
      await sleep(500);
    }
  } while (cursor && page < MAX_PAGES);

  console.log(`[Twitter] fetchViralTweets → ${processed} tweets upserted (${page} pages)`);
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
  return updated;
}

module.exports = { fetchViralTweets, refreshTrackedTweets };
