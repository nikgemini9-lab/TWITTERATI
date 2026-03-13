const db = require('./index');

// ─── Virality Score ───────────────────────────────────────────────────────────
// Acceleration is the most valuable signal — weight it heavily.

function calcViralityScore({ likes = 0, retweets = 0, replies = 0, views = 0, acceleration = 0, engagement_rate = 0 }) {
  const base = (likes * 1) + (retweets * 2) + (replies * 1.5) + (views / 1000);
  const accelBonus = Math.max(0, acceleration) * 8;      // reward accelerating tweets
  const engBonus   = (engagement_rate || 0) * 40;        // reward high engagement rate
  return Math.round(base + accelBonus + engBonus);
}

// ─── Upsert tweet (create or update metrics) ─────────────────────────────────

async function upsertTweet(data) {
  const engagement_rate = data.views > 0
    ? Math.min(100, (data.likes / data.views) * 100)
    : 0;
  const rt_ratio = data.likes > 0
    ? Math.min(100, (data.retweets / data.likes) * 100)
    : 0;

  const score = calcViralityScore({ ...data, engagement_rate });

  await db.query(
    `INSERT INTO tweets (
       tweet_id, author_handle, author_name, tweet_text,
       likes, retweets, replies, views, bookmarks, quotes,
       posted_at, tweet_url, has_media, media_type,
       engagement_rate, rt_ratio, virality_score, last_updated
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
     ON CONFLICT (tweet_id) DO UPDATE SET
       likes          = EXCLUDED.likes,
       retweets       = EXCLUDED.retweets,
       replies        = EXCLUDED.replies,
       views          = EXCLUDED.views,
       bookmarks      = EXCLUDED.bookmarks,
       quotes         = EXCLUDED.quotes,
       engagement_rate= EXCLUDED.engagement_rate,
       rt_ratio       = EXCLUDED.rt_ratio,
       virality_score = EXCLUDED.virality_score,
       last_updated   = NOW(),
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
      parseFloat(engagement_rate.toFixed(4)),
      parseFloat(rt_ratio.toFixed(4)),
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
       AND status != 'fading'
     ORDER BY acceleration DESC, likes DESC
     LIMIT 1000`
  );
  return rows.map((r) => r.tweet_id);
}

// ─── Recalculate velocity + acceleration + status ─────────────────────────────
//
// Three-point model per tweet:
//   latest   = most recent snapshot
//   mid      = snapshot 5–25 minutes ago  (recent velocity window)
//   baseline = snapshot >25 minutes ago   (earlier velocity window)
//
// vel_recent  = (latest.likes  - mid.likes)  / elapsed_hours  → current lph
// vel_earlier = (mid.likes     - baseline.likes) / elapsed_hours
// acceleration = vel_recent - vel_earlier   (positive = speeding up)
//
// Status rules (in priority order):
//   parabolic : vel_recent > 500  AND acceleration >= 0   (fast + still speeding up)
//   fast      : vel_recent > 300                          (high velocity, direction unknown)
//   warming   : acceleration > 100 AND vel_recent > 30    (low-likes but accelerating — early signal)
//   fading    : acceleration < -250                       (clearly peaked)
//   normal    : everything else

async function recalculateGrowth() {
  const { rows } = await db.query(`
    WITH latest AS (
      SELECT DISTINCT ON (tweet_id)
        tweet_id, likes, views, recorded_at
      FROM tweet_snapshots
      ORDER BY tweet_id, recorded_at DESC
    ),
    mid AS (
      SELECT DISTINCT ON (tweet_id)
        tweet_id, likes, views, recorded_at
      FROM tweet_snapshots
      WHERE recorded_at BETWEEN NOW() - INTERVAL '25 minutes'
                            AND NOW() - INTERVAL '5 minutes'
      ORDER BY tweet_id, recorded_at DESC
    ),
    baseline AS (
      SELECT DISTINCT ON (tweet_id)
        tweet_id, likes, views, recorded_at
      FROM tweet_snapshots
      WHERE recorded_at <= NOW() - INTERVAL '25 minutes'
      ORDER BY tweet_id, recorded_at DESC
    )
    SELECT
      l.tweet_id,

      -- recent velocity (latest → mid)
      CASE WHEN m.tweet_id IS NOT NULL AND l.recorded_at > m.recorded_at THEN
        GREATEST(0, l.likes - m.likes)::FLOAT /
        GREATEST(0.01, EXTRACT(EPOCH FROM (l.recorded_at - m.recorded_at)) / 3600.0)
      ELSE 0 END AS vel_recent,

      -- recent views velocity
      CASE WHEN m.tweet_id IS NOT NULL AND l.recorded_at > m.recorded_at THEN
        GREATEST(0, l.views - m.views)::FLOAT /
        GREATEST(0.01, EXTRACT(EPOCH FROM (l.recorded_at - m.recorded_at)) / 3600.0)
      ELSE 0 END AS vph_recent,

      -- earlier velocity (mid → baseline) — NULL if we don't have 3 points yet
      CASE WHEN m.tweet_id IS NOT NULL AND b.tweet_id IS NOT NULL
                AND m.recorded_at > b.recorded_at THEN
        GREATEST(0, m.likes - b.likes)::FLOAT /
        GREATEST(0.01, EXTRACT(EPOCH FROM (m.recorded_at - b.recorded_at)) / 3600.0)
      ELSE NULL END AS vel_earlier

    FROM latest l
    LEFT JOIN mid      m ON l.tweet_id = m.tweet_id
    LEFT JOIN baseline b ON l.tweet_id = b.tweet_id
  `);

  for (const row of rows) {
    const lph   = row.vel_recent;
    const vph   = row.vph_recent;
    const accel = row.vel_earlier !== null
      ? lph - parseFloat(row.vel_earlier)
      : null;   // null = only 1–2 snapshots, can't determine acceleration yet

    let status = 'normal';

    if (lph > 500 && (accel === null || accel >= 0)) {
      status = 'parabolic';                     // fast + still speeding up (or first reading)
    } else if (lph > 300) {
      status = 'fast';                          // high velocity regardless of direction
    } else if (accel !== null && accel > 100 && lph > 30) {
      status = 'warming';                       // low likes but clearly accelerating — EARLY SIGNAL
    } else if (accel !== null && accel < -250) {
      status = 'fading';                        // peaked, velocity collapsing
    }

    await db.query(
      `UPDATE tweets
       SET likes_per_hour = $1,
           views_per_hour = $2,
           acceleration   = $3,
           status         = $4,
           last_updated   = NOW()
       WHERE tweet_id = $5`,
      [
        Math.round(lph),
        Math.round(vph),
        accel !== null ? Math.round(accel) : 0,
        status,
        row.tweet_id,
      ]
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
    acceleration: 'acceleration DESC, likes_per_hour DESC',
    likes:        'likes DESC',
    views:        'views DESC',
    virality:     'virality_score DESC',
    growth:       'likes_per_hour DESC',
    newest:       'posted_at DESC',
    engagement:   'engagement_rate DESC',
  };
  const orderBy = sortMap[filters.sort] || 'acceleration DESC, likes_per_hour DESC';

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
      COUNT(*)                                              AS total_tweets,
      COUNT(*) FILTER (WHERE status = 'parabolic')         AS parabolic_count,
      COUNT(*) FILTER (WHERE status = 'fast')              AS fast_count,
      COUNT(*) FILTER (WHERE status = 'warming')           AS warming_count,
      COUNT(*) FILTER (WHERE status = 'fading')            AS fading_count,
      COALESCE(MAX(likes), 0)                              AS max_likes,
      COALESCE(MAX(views), 0)                              AS max_views,
      COALESCE(MAX(acceleration), 0)                       AS max_acceleration,
      MAX(last_updated)                                    AS last_updated,
      (SELECT COUNT(*) FROM tweets)                        AS total_all_time
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
