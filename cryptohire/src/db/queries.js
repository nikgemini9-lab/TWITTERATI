'use strict';

const { query } = require('./index');

// ─── Seen-tweet dedup ─────────────────────────────────────────────────────────

async function markSeen(tweetIds) {
  if (!tweetIds.length) return;
  const values = tweetIds.map((id, i) => `($${i + 1})`).join(', ');
  await query(
    `INSERT INTO seen_tweets (tweet_id) VALUES ${values} ON CONFLICT DO NOTHING`,
    tweetIds
  );
}

async function filterUnseen(tweetIds) {
  if (!tweetIds.length) return [];
  const { rows } = await query(
    `SELECT tweet_id FROM seen_tweets WHERE tweet_id = ANY($1)`,
    [tweetIds]
  );
  const seen = new Set(rows.map((r) => r.tweet_id));
  return tweetIds.filter((id) => !seen.has(id));
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

async function upsertJob(job) {
  await query(
    `INSERT INTO jobs (
      tweet_id, author_handle, author_name, author_bio, author_followers,
      author_verified, tweet_text, likes, retweets, replies, views,
      posted_at, tweet_url,
      role_type, subspace, remote, seniority, contact_method, ai_summary,
      confidence, classified_at, last_updated
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
      $14,$15,$16,$17,$18,$19,$20,NOW(),NOW()
    )
    ON CONFLICT (tweet_id) DO UPDATE SET
      likes           = EXCLUDED.likes,
      retweets        = EXCLUDED.retweets,
      replies         = EXCLUDED.replies,
      views           = EXCLUDED.views,
      last_updated    = NOW()`,
    [
      job.tweet_id, job.author_handle, job.author_name, job.author_bio,
      job.author_followers, job.author_verified, job.tweet_text,
      job.likes, job.retweets, job.replies, job.views,
      job.posted_at, job.tweet_url,
      job.role_type, job.subspace, job.remote, job.seniority,
      job.contact_method, job.ai_summary, job.confidence,
    ]
  );
}

async function getJobs(filters = {}) {
  const conditions = ['NOT is_archived'];
  const params     = [];
  let   p          = 1;

  if (filters.role_type && filters.role_type !== 'all') {
    conditions.push(`role_type = $${p++}`);
    params.push(filters.role_type);
  }
  if (filters.subspace && filters.subspace !== 'all') {
    conditions.push(`subspace = $${p++}`);
    params.push(filters.subspace);
  }
  if (filters.remote !== undefined && filters.remote !== '') {
    conditions.push(`remote = $${p++}`);
    params.push(filters.remote === 'true');
  }
  if (filters.seniority && filters.seniority !== 'all') {
    conditions.push(`seniority = $${p++}`);
    params.push(filters.seniority);
  }
  if (filters.search) {
    conditions.push(`(tweet_text ILIKE $${p} OR author_handle ILIKE $${p} OR ai_summary ILIKE $${p})`);
    params.push(`%${filters.search}%`);
    p++;
  }
  if (filters.is_filled === 'true') {
    conditions.push('is_filled = TRUE');
  } else {
    conditions.push('is_filled = FALSE');
  }

  const where = conditions.join(' AND ');
  const sort  = filters.sort === 'likes'    ? 'likes DESC'
              : filters.sort === 'earliest' ? 'posted_at ASC'
              :                               'posted_at DESC';

  const limit = Math.min(parseInt(filters.limit, 10) || 200, 500);

  const { rows } = await query(
    `SELECT * FROM jobs WHERE ${where} ORDER BY ${sort} LIMIT $${p}`,
    [...params, limit]
  );
  return rows;
}

async function archiveJob(tweetId) {
  await query(
    `UPDATE jobs SET is_archived = TRUE, archived_at = NOW() WHERE tweet_id = $1`,
    [tweetId]
  );
}

async function markFilled(tweetId, filled) {
  await query(
    `UPDATE jobs SET is_filled = $1, last_updated = NOW() WHERE tweet_id = $2`,
    [filled, tweetId]
  );
}

async function getStats() {
  const { rows } = await query(`
    SELECT
      COUNT(*)                                        AS total,
      COUNT(*) FILTER (WHERE NOT is_archived AND NOT is_filled) AS active,
      COUNT(*) FILTER (WHERE is_filled)               AS filled,
      COUNT(*) FILTER (WHERE remote = TRUE)           AS remote,
      COUNT(*) FILTER (WHERE posted_at > NOW() - INTERVAL '24h' AND NOT is_archived) AS last_24h,
      COUNT(*) FILTER (WHERE posted_at > NOW() - INTERVAL '7d'  AND NOT is_archived) AS last_7d
    FROM jobs
  `);
  return rows[0];
}

async function getRoleStats() {
  const { rows } = await query(`
    SELECT role_type, COUNT(*) AS count
    FROM jobs
    WHERE NOT is_archived AND NOT is_filled
    GROUP BY role_type
    ORDER BY count DESC
  `);
  return rows;
}

async function getSubspaceStats() {
  const { rows } = await query(`
    SELECT subspace, COUNT(*) AS count
    FROM jobs
    WHERE NOT is_archived AND NOT is_filled
    GROUP BY subspace
    ORDER BY count DESC
  `);
  return rows;
}

// ─── VIP watchlist ────────────────────────────────────────────────────────────

async function getVipWatchlist() {
  const { rows } = await query(`SELECT handle, user_id FROM vip_watchlist ORDER BY added_at`);
  return rows;
}

async function addToVipWatchlist(handle) {
  await query(
    `INSERT INTO vip_watchlist (handle) VALUES ($1) ON CONFLICT DO NOTHING`,
    [handle.toLowerCase().replace(/^@/, '')]
  );
}

async function removeFromVipWatchlist(handle) {
  await query(`DELETE FROM vip_watchlist WHERE handle = $1`, [handle.toLowerCase()]);
}

async function setVipUserId(handle, userId) {
  await query(`UPDATE vip_watchlist SET user_id = $1 WHERE handle = $2`, [userId, handle]);
}

module.exports = {
  markSeen, filterUnseen,
  upsertJob, getJobs, archiveJob, markFilled,
  getStats, getRoleStats, getSubspaceStats,
  getVipWatchlist, addToVipWatchlist, removeFromVipWatchlist, setVipUserId,
};
