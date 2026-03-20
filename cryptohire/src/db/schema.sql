-- CryptoHire schema (SQLite / Turso)

CREATE TABLE IF NOT EXISTS jobs (
  tweet_id         TEXT PRIMARY KEY,
  author_handle    TEXT NOT NULL DEFAULT '',
  author_name      TEXT NOT NULL DEFAULT '',
  author_bio       TEXT,
  author_followers INTEGER NOT NULL DEFAULT 0,
  author_verified  INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  tweet_text       TEXT,
  likes            INTEGER NOT NULL DEFAULT 0,
  retweets         INTEGER NOT NULL DEFAULT 0,
  replies          INTEGER NOT NULL DEFAULT 0,
  views            INTEGER NOT NULL DEFAULT 0,
  posted_at        TEXT,
  first_detected   TEXT NOT NULL DEFAULT (datetime('now')),
  last_updated     TEXT NOT NULL DEFAULT (datetime('now')),
  tweet_url        TEXT,

  -- AI classification output
  role_type        TEXT,    -- engineer | researcher | trader | analyst | marketing | ops | design | bd | content | other
  subspace         TEXT,    -- prediction_markets | defi | trading | nft | infrastructure | general_web3 | other
  remote           INTEGER,                  -- 0/1 boolean, nullable
  seniority        TEXT,    -- junior | mid | senior | lead | any
  contact_method   TEXT,    -- dm | email | link | apply
  ai_summary       TEXT,
  confidence       REAL,
  classified_at    TEXT,

  -- Manual management
  is_archived      INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  is_filled        INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  archived_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_posted_at    ON jobs(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_role_type    ON jobs(role_type);
CREATE INDEX IF NOT EXISTS idx_jobs_subspace     ON jobs(subspace);
CREATE INDEX IF NOT EXISTS idx_jobs_remote       ON jobs(remote);
CREATE INDEX IF NOT EXISTS idx_jobs_is_archived  ON jobs(is_archived);
CREATE INDEX IF NOT EXISTS idx_jobs_is_filled    ON jobs(is_filled);
CREATE INDEX IF NOT EXISTS idx_jobs_likes        ON jobs(likes DESC);

CREATE TABLE IF NOT EXISTS seen_tweets (
  tweet_id TEXT PRIMARY KEY,
  seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vip_watchlist (
  handle   TEXT PRIMARY KEY,
  user_id  TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
