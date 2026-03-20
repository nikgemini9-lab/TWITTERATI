'use strict';

const { query } = require('./index');

// SQLite stores booleans as 0/1 integers — coerce back to JS booleans for the API
function coerceJob(row) {
  return {
    ...row,
    author_verified: Boolean(row.author_verified),
    remote:          row.remote === null ? null : Boolean(row.remote),
    is_archived:     Boolean(row.is_archived),
    is_filled:       Boolean(row.is_filled),
  };
}

// ─── Seen-tweet dedup ─────────────────────────────────────────────────────────

async function markSeen(tweetIds) {
  if (!tweetIds.length) return;
  const placeholders = tweetIds.map(() => '(?)').join(', ');
  await query(
    `INSERT INTO seen_tweets (tweet_id) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
    tweetIds
  );
}

async function filterUnseen(tweetIds) {
  if (!tweetIds.length) return [];
  const placeholders = tweetIds.map(() => '?').join(', ');
  const { rows } = await query(
    `SELECT tweet_id FROM seen_tweets WHERE tweet_id IN (${placeholders})`,
    tweetIds
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
      confidence, quality_score, poster_type, role_title, company, skills,
      classified_at, last_updated
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT (tweet_id) DO UPDATE SET
      likes         = excluded.likes,
      retweets      = excluded.retweets,
      replies       = excluded.replies,
      views         = excluded.views,
      last_updated  = datetime('now')`,
    [
      job.tweet_id, job.author_handle, job.author_name, job.author_bio,
      job.author_followers,
      job.author_verified ? 1 : 0,
      job.tweet_text,
      job.likes, job.retweets, job.replies, job.views,
      job.posted_at, job.tweet_url,
      job.role_type, job.subspace,
      job.remote === null || job.remote === undefined ? null : (job.remote ? 1 : 0),
      job.seniority, job.contact_method, job.ai_summary, job.confidence,
      job.quality_score ?? null, job.poster_type ?? null,
      job.role_title ?? null, job.company ?? null, job.skills ?? null,
    ]
  );
}

async function getJobs(filters = {}) {
  const conditions = ['NOT is_archived'];
  const params     = [];

  if (filters.role_type && filters.role_type !== 'all') {
    conditions.push('role_type = ?');
    params.push(filters.role_type);
  }
  if (filters.subspace && filters.subspace !== 'all') {
    conditions.push('subspace = ?');
    params.push(filters.subspace);
  }
  if (filters.remote !== undefined && filters.remote !== '') {
    conditions.push('remote = ?');
    params.push(filters.remote === 'true' ? 1 : 0);
  }
  if (filters.seniority && filters.seniority !== 'all') {
    conditions.push('seniority = ?');
    params.push(filters.seniority);
  }
  if (filters.search) {
    // SQLite LIKE is case-insensitive for ASCII by default
    conditions.push('(tweet_text LIKE ? OR author_handle LIKE ? OR ai_summary LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.is_filled === 'true') {
    conditions.push('is_filled = 1');
  } else {
    conditions.push('is_filled = 0');
  }

  const where = conditions.join(' AND ');
  const sort  = filters.sort === 'likes'    ? 'likes DESC'
              : filters.sort === 'earliest' ? 'posted_at ASC'
              :                               'posted_at DESC';
  const limit = Math.min(parseInt(filters.limit, 10) || 200, 500);
  params.push(limit);

  const { rows } = await query(
    `SELECT * FROM jobs WHERE ${where} ORDER BY ${sort} LIMIT ?`,
    params
  );
  return rows.map(coerceJob);
}

async function archiveJob(tweetId) {
  // Fetch the job first so the caller can save it as a negative training example
  const { rows } = await query(`SELECT * FROM jobs WHERE tweet_id = ?`, [tweetId]);
  await query(
    `UPDATE jobs SET is_archived = 1, archived_at = datetime('now') WHERE tweet_id = ?`,
    [tweetId]
  );
  return rows[0] || null;
}

async function markFilled(tweetId, filled) {
  await query(
    `UPDATE jobs SET is_filled = ?, last_updated = datetime('now') WHERE tweet_id = ?`,
    [filled ? 1 : 0, tweetId]
  );
}

async function getStats() {
  const { rows } = await query(`
    SELECT
      COUNT(*)                                                                        AS total,
      COUNT(*) FILTER (WHERE NOT is_archived AND NOT is_filled)                      AS active,
      COUNT(*) FILTER (WHERE is_filled)                                              AS filled,
      COUNT(*) FILTER (WHERE remote = 1)                                             AS remote,
      COUNT(*) FILTER (WHERE posted_at > datetime('now', '-24 hours') AND NOT is_archived) AS last_24h,
      COUNT(*) FILTER (WHERE posted_at > datetime('now', '-7 days')   AND NOT is_archived) AS last_7d
    FROM jobs
  `);
  const r = rows[0];
  return {
    total:    Number(r.total),
    active:   Number(r.active),
    filled:   Number(r.filled),
    remote:   Number(r.remote),
    last_24h: Number(r.last_24h),
    last_7d:  Number(r.last_7d),
  };
}

async function getRoleStats() {
  const { rows } = await query(`
    SELECT role_type, COUNT(*) AS count
    FROM jobs
    WHERE NOT is_archived AND NOT is_filled
    GROUP BY role_type
    ORDER BY count DESC
  `);
  return rows.map((r) => ({ role_type: r.role_type, count: Number(r.count) }));
}

async function getSubspaceStats() {
  const { rows } = await query(`
    SELECT subspace, COUNT(*) AS count
    FROM jobs
    WHERE NOT is_archived AND NOT is_filled
    GROUP BY subspace
    ORDER BY count DESC
  `);
  return rows.map((r) => ({ subspace: r.subspace, count: Number(r.count) }));
}

// ─── VIP watchlist ────────────────────────────────────────────────────────────

async function getVipWatchlist() {
  const { rows } = await query(`SELECT handle, user_id FROM vip_watchlist ORDER BY added_at`);
  return rows;
}

async function addToVipWatchlist(handle) {
  await query(
    `INSERT INTO vip_watchlist (handle) VALUES (?) ON CONFLICT DO NOTHING`,
    [handle.toLowerCase().replace(/^@/, '')]
  );
}

async function removeFromVipWatchlist(handle) {
  await query(`DELETE FROM vip_watchlist WHERE handle = ?`, [handle.toLowerCase()]);
}

async function setVipUserId(handle, userId) {
  await query(`UPDATE vip_watchlist SET user_id = ? WHERE handle = ?`, [userId, handle]);
}

// ─── Training examples ────────────────────────────────────────────────────────

async function addTrainingExample(ex) {
  const isPositive = ex.is_positive === false ? 0 : 1;
  const { rows } = await query(
    `INSERT INTO training_examples (tweet_text, author_bio, author_handle, role_type, subspace, is_positive, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [ex.tweet_text, ex.author_bio || '', ex.author_handle || '', ex.role_type || null, ex.subspace || null, isPositive, ex.note || null]
  );
  return rows[0]?.id;
}

async function getTrainingExamples(limit = 10) {
  const { rows } = await query(
    `SELECT * FROM training_examples ORDER BY added_at DESC LIMIT ?`,
    [limit]
  );
  return rows;
}

async function deleteTrainingExample(id) {
  await query(`DELETE FROM training_examples WHERE id = ?`, [id]);
}

async function clearSeen() {
  await query(`DELETE FROM seen_tweets`);
}

async function getSeenCount() {
  const { rows } = await query(`SELECT COUNT(*) AS n FROM seen_tweets`);
  return Number(rows[0].n);
}

module.exports = {
  markSeen, filterUnseen, clearSeen, getSeenCount,
  upsertJob, getJobs, archiveJob, markFilled,
  getStats, getRoleStats, getSubspaceStats,
  getVipWatchlist, addToVipWatchlist, removeFromVipWatchlist, setVipUserId,
  addTrainingExample, getTrainingExamples, deleteTrainingExample,
};
