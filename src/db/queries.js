const db = require('./index');

// ─── Virality Score ───────────────────────────────────────────────────────────
//
// Formula: Velocity × Spread × Momentum
//
//   velocity  = effective likes/hr (real lph if known, else likes ÷ age)
//   spread    = RT ratio amplifier — content being shared > liked means it's
//               escaping the author's follower base (strong viral signal)
//   momentum  = acceleration bonus — still climbing vs peaked
//   quality   = engagement rate (likes ÷ views) — sticky content
//
// Result is intentionally un-capped so parabolic tweets score orders of
// magnitude above normal ones, making ranking meaningful.

function calcViralityScore({
  likes = 0, retweets = 0, views = 0, bookmarks = 0, replies = 0,
  likes_per_hour = 0, acceleration = 0,
  engagement_rate = 0, rt_ratio = 0,
  posted_at = null,
}) {
  // Use real-time lph if available; otherwise estimate from tweet age
  const ageHours = posted_at
    ? Math.max(0.5, (Date.now() - new Date(posted_at)) / 3_600_000)
    : 24;
  const effectiveLph = likes_per_hour > 0 ? likes_per_hour : Math.round(likes / ageHours);

  // 1. Velocity — how fast is it gaining likes RIGHT NOW?
  const velocityScore = effectiveLph * 4;

  // 2. Spread — RT/like ratio: content being shared beats content being liked
  //    rt_ratio is stored as (retweets/likes)*100, so 50 = 50%
  const spreadScore = (rt_ratio || 0) * 20;

  // 3. Momentum — still accelerating? big bonus
  const momentumScore = Math.max(0, acceleration) * 3;

  // 4. Engagement quality — likes/views ratio rewards content people act on
  const engagementScore = (engagement_rate || 0) * 30;

  // 5. Base gravity — log scale so raw size matters but doesn't dominate
  const baseScore = Math.log10(Math.max(10, likes)) * 60;

  // 6. Bookmark signal — people saving = strong intent (meme/token/reference material)
  //    bookmark_ratio = bookmarks/likes * 100 (e.g. 7.7 for "Albert Whiskars" type memes)
  //    Normal tweet: ~0.5  |  Viral meme: 3–10  → big bonus when high
  const bookmarkRatio = likes > 0 ? (bookmarks / likes) * 100 : 0;
  const bookmarkScore = bookmarkRatio * 40;

  // 7. Meme fingerprint — high RT:reply ratio means silent spreading, not debate
  //    Memes: 20–40:1  |  News/political: 3–5:1
  const rtReplyRatio = retweets / Math.max(1, replies);
  const memeSpreadBonus = rtReplyRatio > 10 ? Math.min(200, rtReplyRatio * 5) : 0;

  return Math.round(velocityScore + spreadScore + momentumScore + engagementScore + baseScore + bookmarkScore + memeSpreadBonus);
}

// ─── Upsert tweet (create or update metrics) ─────────────────────────────────

async function upsertTweet(data) {
  const engagement_rate = data.views > 0
    ? Math.min(100, (data.likes / data.views) * 100)
    : 0;
  const rt_ratio = data.likes > 0
    ? Math.min(100, (data.retweets / data.likes) * 100)
    : 0;

  const score = calcViralityScore({ ...data, engagement_rate, rt_ratio,
    bookmarks: data.bookmarks || 0, replies: data.replies || 0 });

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
      t.likes, t.retweets, t.replies, t.views, t.bookmarks, t.engagement_rate, t.rt_ratio, t.posted_at,

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
    JOIN tweets t ON l.tweet_id = t.tweet_id
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

    const viralityScore = calcViralityScore({
      likes:          row.likes,
      retweets:       row.retweets,
      replies:        row.replies,
      views:          row.views,
      bookmarks:      row.bookmarks || 0,
      likes_per_hour: Math.round(lph),
      acceleration:   accel !== null ? Math.round(accel) : 0,
      engagement_rate: parseFloat(row.engagement_rate) || 0,
      rt_ratio:       parseFloat(row.rt_ratio) || 0,
      posted_at:      row.posted_at,
    });

    await db.query(
      `UPDATE tweets
       SET likes_per_hour = $1,
           views_per_hour = $2,
           acceleration   = $3,
           status         = $4,
           virality_score = $5,
           last_updated   = NOW()
       WHERE tweet_id = $6`,
      [
        Math.round(lph),
        Math.round(vph),
        accel !== null ? Math.round(accel) : 0,
        status,
        viralityScore,
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

  // media filter: photo | video | gif | any_media | text  (also legacy has_media=true/false)
  const media = filters.media || (filters.has_media === 'true' ? 'any_media' : filters.has_media === 'false' ? 'text' : '');
  if (media === 'text') {
    conditions.push(`has_media = false`);
  } else if (media === 'any_media') {
    conditions.push(`has_media = true`);
  } else if (media === 'photo' || media === 'video' || media === 'gif') {
    conditions.push(`media_type = $${idx++}`);
    params.push(media);
  }

  // Always exclude blacklisted handles (blacklist stored lowercase, compare with LOWER)
  conditions.push(`LOWER(author_handle) NOT IN (SELECT handle FROM blacklist)`);

  if (filters.min_likes) {
    conditions.push(`likes >= $${idx++}`);
    params.push(parseInt(filters.min_likes, 10));
  }

  if (filters.author) {
    conditions.push(`author_handle ILIKE $${idx++}`);
    params.push(`%${filters.author}%`);
  }

  if (filters.topic) {
    conditions.push(`topic = $${idx++}`);
    params.push(filters.topic);
  }

  const sortMap = {
    'acceleration':      'acceleration DESC, likes_per_hour DESC',
    'acceleration:asc':  'acceleration ASC,  likes_per_hour ASC',
    'likes':             'likes DESC',
    'likes:asc':         'likes ASC',
    'views':             'views DESC',
    'views:asc':         'views ASC',
    'virality':          'virality_score DESC',
    'virality:asc':      'virality_score ASC',
    'growth':            'likes_per_hour DESC',
    'growth:asc':        'likes_per_hour ASC',
    'newest':            'posted_at DESC',
    'newest:asc':        'posted_at ASC',
    'engagement':        'engagement_rate DESC',
    'engagement:asc':    'engagement_rate ASC',
  };
  const orderBy = sortMap[filters.sort] || 'acceleration DESC, likes_per_hour DESC';

  const limit = Math.min(parseInt(filters.limit, 10) || 1000, 5000);

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

// ─── Blacklist CRUD ───────────────────────────────────────────────────────────

async function getBlacklist() {
  const { rows } = await db.query(`SELECT handle, added_at FROM blacklist ORDER BY added_at DESC`);
  return rows;
}

async function addToBlacklist(handle) {
  const h = handle.replace(/^@/, '').toLowerCase().trim();
  await db.query(`INSERT INTO blacklist (handle) VALUES ($1) ON CONFLICT DO NOTHING`, [h]);
}

async function removeFromBlacklist(handle) {
  const h = handle.replace(/^@/, '').toLowerCase().trim();
  await db.query(`DELETE FROM blacklist WHERE handle = $1`, [h]);
}

// ─── Topic classification helpers ─────────────────────────────────────────────

async function getUnclassifiedTweets(limit = 50) {
  const { rows } = await db.query(
    `SELECT tweet_id, tweet_text
     FROM tweets
     WHERE topic IS NULL
       AND tweet_text IS NOT NULL
       AND tweet_text != ''
     ORDER BY virality_score DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function bulkSetTopics(results) {
  if (!results.length) return;
  const cases    = results.map((_, i) => `WHEN $${i * 2 + 1} THEN $${i * 2 + 2}`).join(' ');
  const ids      = results.map(r => r.tweet_id);
  const params   = results.flatMap(r => [r.tweet_id, r.topic]);
  const idParams = ids.map((_, i) => `$${results.length * 2 + i + 1}`).join(',');
  await db.query(
    `UPDATE tweets SET topic = CASE tweet_id ${cases} END WHERE tweet_id IN (${idParams})`,
    [...params, ...ids]
  );
}

async function getTopicStats() {
  const { rows } = await db.query(`
    SELECT
      topic,
      COUNT(*)                                      AS tweet_count,
      ROUND(AVG(virality_score)::NUMERIC, 0)        AS avg_virality,
      MAX(likes)                                    AS max_likes,
      MAX(virality_score)                           AS max_virality,
      (SELECT tweet_url
       FROM tweets t2
       WHERE t2.topic = t.topic
         AND t2.posted_at > NOW() - INTERVAL '48 hours'
         AND t2.tweet_url IS NOT NULL
       ORDER BY t2.virality_score DESC
       LIMIT 1)                                     AS top_tweet_url,
      jsonb_build_object(
        'parabolic', COUNT(*) FILTER (WHERE status = 'parabolic'),
        'fast',      COUNT(*) FILTER (WHERE status = 'fast'),
        'warming',   COUNT(*) FILTER (WHERE status = 'warming'),
        'normal',    COUNT(*) FILTER (WHERE status = 'normal'),
        'fading',    COUNT(*) FILTER (WHERE status = 'fading')
      )                                             AS status_mix,
      (CASE
        WHEN COUNT(*) FILTER (WHERE status = 'parabolic') > 0 THEN 'parabolic'
        WHEN COUNT(*) FILTER (WHERE status = 'fast')      > 0 THEN 'fast'
        WHEN COUNT(*) FILTER (WHERE status = 'warming')   > 0 THEN 'warming'
        ELSE 'normal'
       END)                                         AS hottest_status
    FROM tweets t
    WHERE posted_at > NOW() - INTERVAL '48 hours'
      AND topic IS NOT NULL
      AND LOWER(author_handle) NOT IN (SELECT handle FROM blacklist)
    GROUP BY topic
    ORDER BY avg_virality DESC
  `);
  return rows;
}

// ─── Meme History CRUD ────────────────────────────────────────────────────────

async function getMemeHistory() {
  const { rows } = await db.query(`
    SELECT * FROM meme_history ORDER BY marked_at DESC
  `);
  return rows;
}

async function addToMemeHistory(tweet) {
  await db.query(`
    INSERT INTO meme_history (
      tweet_id, author_handle, author_name, tweet_text,
      likes, retweets, replies, views, bookmarks,
      has_media, media_type, status, virality_score,
      engagement_rate, rt_ratio, likes_per_hour,
      topic, tweet_url, posted_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
    ) ON CONFLICT (tweet_id) DO NOTHING`,
    [
      tweet.tweet_id, tweet.author_handle, tweet.author_name, tweet.tweet_text,
      tweet.likes || 0, tweet.retweets || 0, tweet.replies || 0,
      tweet.views || 0, tweet.bookmarks || 0,
      tweet.has_media || false, tweet.media_type || null,
      tweet.status || null, tweet.virality_score || 0,
      tweet.engagement_rate || 0, tweet.rt_ratio || 0, tweet.likes_per_hour || 0,
      tweet.topic || null, tweet.tweet_url || null, tweet.posted_at || null,
    ]
  );
}

async function removeFromMemeHistory(tweetId) {
  await db.query(`DELETE FROM meme_history WHERE tweet_id = $1`, [tweetId]);
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
  getBlacklist,
  addToBlacklist,
  removeFromBlacklist,
  getUnclassifiedTweets,
  bulkSetTopics,
  getTopicStats,
  getMemeHistory,
  addToMemeHistory,
  removeFromMemeHistory,
};
