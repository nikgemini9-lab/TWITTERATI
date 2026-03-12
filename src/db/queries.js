const db = require('./index');

// ─── Virality Score ───────────────────────────────────────────────────────────

function calcViralityScore({ likes = 0, retweets = 0, replies = 0, views = 0 }) {
  return (likes * 1) + (retweets * 2) + (replies * 1.5) + (views / 1000);
}

// ─── Upsert tweet (create or update metrics) ─────────────────────────────────

async function upsertTweet(data) {
  const score = calcViralityScore(data);

  await db.query(
    `INSERT INTO tweets (
       tweet_id, author_handle, author_name, tweet_text,
       likes, retweets, replies, views, bookmarks, quotes,
       posted_at, tweet_url, has_media, media_type,
       virality_score, last_updated
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
     ON CONFLICT (tweet_id) DO UPDATE SET
       likes          = EXCLUDED.likes,
       retweets       = EXCLUDED.retweets,
       replies        = EXCLUDED.replies,
       views          = EXCLUDED.views,
       bookmarks      = EXCLUDED.bookmarks,
       quotes         = EXCLUDED.quotes,
       virality_score = EXCLUDED.virality_score,
       last_updated   = NOW(),
       -- only overwrite text fields when the incoming value is non-null
       author_handle  = COALESCE(NULLIF(EXCLUDED.author_handle,''), tweets.author_handle),
       author_name    = COALESCE(NULLIF(EXCLUDED.author_name,''),   tweets.author_name),
       tweet_text     = COALESCE(EXCLUDED.tweet_text, tweets.tweet_text),
       tweet_url      = COALESCE(EXCLUDED.tweet_url,  tweets.tweet_url),
       has_media      = COALESCE(EXCLUDED.has_media,  tweets.has_media),
       media_type     = COALESCE(EXCLUDED.media_type, tweets.media_type)`,
    [
      data.tweet_id,
      data.author_handle || '',
      data.author_name   || '',
      data.tweet_text    || null,
      data.likes         || 0,
      data.retweets      || 0,
      data.replies       || 0,
      data.views         || 0,
      data.bookmarks     || 0,
      data.quotes        || 0,
      data.posted_at     || null,
      data.tweet_url     || null,
      data.has_media     || false,
      data.media_type    || null,
      score,
    ]
  );
}

// ─── Insert snapshot ──────────────────────────────────────────────────────────

async function insertSnapshot(tweetId, metrics) {
  await db.query(
    `INSERT INTO tweet_snapshots (tweet_id, likes, retweets, replies, views, bookmarks)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      tweetId,
      metrics.like_count       || 0,
      metrics.retweet_count    || 0,
      metrics.reply_count      || 0,
      metrics.impression_count || 0,
      metrics.bookmark_count   || 0,
    ]
  );
}

// ─── Get IDs of tweets still worth tracking ───────────────────────────────────

async function getTweetIdsForRefresh() {
  const { rows } = await db.query(
    `SELECT tweet_id FROM tweets
     WHERE posted_at > NOW() - INTERVAL '7 days'
     ORDER BY likes DESC
     LIMIT 1000`
  );
  return rows.map((r) => r.tweet_id);
}

// ─── Recalculate growth rates and update status ───────────────────────────────
//
// For every tweet we find:
//   latest_snapshot  – the most recent snapshot
//   baseline         – the most recent snapshot recorded ≥ 55 min ago
// Then we compute:
//   likes_per_hour = (latest.likes - baseline.likes) / elapsed_hours
//   views_per_hour = (latest.views - baseline.views) / elapsed_hours
// Status thresholds:
//   parabolic : likes_per_hour > 2000  OR  views_per_hour > 100000
//   fast      : likes_per_hour > 500   OR  views_per_hour > 20000

async function recalculateGrowth() {
  const { rows } = await db.query(`
    WITH latest AS (
      SELECT DISTINCT ON (tweet_id)
        tweet_id, likes, views, recorded_at
      FROM tweet_snapshots
      ORDER BY tweet_id, recorded_at DESC
    ),
    baseline AS (
      SELECT DISTINCT ON (tweet_id)
        tweet_id, likes, views, recorded_at
      FROM tweet_snapshots
      WHERE recorded_at <= NOW() - INTERVAL '55 minutes'
      ORDER BY tweet_id, recorded_at DESC
    )
    SELECT
      l.tweet_id,
      GREATEST(0, l.likes - b.likes) AS likes_delta,
      GREATEST(0, l.views - b.views) AS views_delta,
      GREATEST(0.01, EXTRACT(EPOCH FROM (l.recorded_at - b.recorded_at)) / 3600.0) AS hours_elapsed
    FROM latest l
    JOIN baseline b ON l.tweet_id = b.tweet_id
  `);

  for (const row of rows) {
    const lph = row.likes_delta / row.hours_elapsed;
    const vph = row.views_delta / row.hours_elapsed;

    let status = 'normal';
    if (lph > 2000 || vph > 100000) status = 'parabolic';
    else if (lph > 500 || vph > 20000) status = 'fast';

    await db.query(
      `UPDATE tweets
       SET likes_per_hour = $1, views_per_hour = $2, status = $3, last_updated = NOW()
       WHERE tweet_id = $4`,
      [Math.round(lph), Math.round(vph), status, row.tweet_id]
    );
  }

  return rows.length;
}

// ─── Query tweets for the dashboard API ──────────────────────────────────────

async function getTweets(filters = {}) {
  const conditions = [`posted_at > NOW() - INTERVAL '48 hours'`];
  const params = [];
  let idx = 1;

  if (filters.status && filters.status !== 'all') {
    conditions.push(`status = $${idx++}`);
    params.push(filters.status);
  }

  if (filters.has_media === 'true') {
    conditions.push(`has_media = true`);
  } else if (filters.has_media === 'false') {
    conditions.push(`has_media = false`);
  }

  if (filters.min_likes) {
    conditions.push(`likes >= $${idx++}`);
    params.push(parseInt(filters.min_likes, 10));
  }

  if (filters.author) {
    conditions.push(`author_handle ILIKE $${idx++}`);
    params.push(`%${filters.author}%`);
  }

  const sortMap = {
    likes:     'likes DESC',
    views:     'views DESC',
    virality:  'virality_score DESC',
    growth:    'likes_per_hour DESC',
    newest:    'posted_at DESC',
  };
  const orderBy = sortMap[filters.sort] || 'likes DESC';

  const limit = Math.min(parseInt(filters.limit, 10) || 100, 500);

  const { rows } = await db.query(
    `SELECT * FROM tweets WHERE ${conditions.join(' AND ')} ORDER BY ${orderBy} LIMIT ${limit}`,
    params
  );

  return rows;
}

// ─── Snapshot history for a single tweet ────────────────────────────────────

async function getTweetHistory(tweetId) {
  const { rows } = await db.query(
    `SELECT likes, views, retweets, recorded_at
     FROM tweet_snapshots
     WHERE tweet_id = $1
     ORDER BY recorded_at ASC`,
    [tweetId]
  );
  return rows;
}

// ─── Stats summary ────────────────────────────────────────────────────────────

async function getStats() {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)                                             AS total_tweets,
      COUNT(*) FILTER (WHERE status = 'parabolic')        AS parabolic_count,
      COUNT(*) FILTER (WHERE status = 'fast')             AS fast_count,
      COALESCE(MAX(likes), 0)                             AS max_likes,
      COALESCE(MAX(views), 0)                             AS max_views,
      MAX(last_updated)                                   AS last_updated
    FROM tweets
    WHERE posted_at > NOW() - INTERVAL '48 hours'
  `);
  return rows[0];
}

// ─── Cleanup old data ─────────────────────────────────────────────────────────

async function cleanup() {
  await db.query(`DELETE FROM tweet_snapshots WHERE recorded_at < NOW() - INTERVAL '7 days'`);
  await db.query(`DELETE FROM tweets WHERE posted_at < NOW() - INTERVAL '7 days'`);
}

module.exports = {
  upsertTweet,
  insertSnapshot,
  getTweetIdsForRefresh,
  recalculateGrowth,
  getTweets,
  getTweetHistory,
  getStats,
  cleanup,
};
