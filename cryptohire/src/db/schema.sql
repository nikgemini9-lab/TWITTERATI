-- CryptoHire schema

CREATE TABLE IF NOT EXISTS jobs (
  tweet_id         TEXT PRIMARY KEY,
  author_handle    TEXT NOT NULL DEFAULT '',
  author_name      TEXT NOT NULL DEFAULT '',
  author_bio       TEXT,
  author_followers INTEGER NOT NULL DEFAULT 0,
  author_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  tweet_text       TEXT,
  likes            INTEGER NOT NULL DEFAULT 0,
  retweets         INTEGER NOT NULL DEFAULT 0,
  replies          INTEGER NOT NULL DEFAULT 0,
  views            INTEGER NOT NULL DEFAULT 0,
  posted_at        TIMESTAMPTZ,
  first_detected   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tweet_url        TEXT,

  -- AI classification output
  role_type        TEXT,    -- engineer | researcher | trader | analyst | marketing | ops | design | bd | content | other
  subspace         TEXT,    -- prediction_markets | defi | trading | nft | infrastructure | general_web3 | other
  remote           BOOLEAN,
  seniority        TEXT,    -- junior | mid | senior | lead | any
  contact_method   TEXT,    -- dm | email | link | apply
  ai_summary       TEXT,    -- one-line human-readable summary
  confidence       NUMERIC,
  classified_at    TIMESTAMPTZ,

  -- Manual management
  is_archived      BOOLEAN NOT NULL DEFAULT FALSE,
  is_filled        BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_posted_at    ON jobs(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_role_type    ON jobs(role_type);
CREATE INDEX IF NOT EXISTS idx_jobs_subspace     ON jobs(subspace);
CREATE INDEX IF NOT EXISTS idx_jobs_remote       ON jobs(remote);
CREATE INDEX IF NOT EXISTS idx_jobs_is_archived  ON jobs(is_archived);
CREATE INDEX IF NOT EXISTS idx_jobs_is_filled    ON jobs(is_filled);
CREATE INDEX IF NOT EXISTS idx_jobs_likes        ON jobs(likes DESC);

-- Tracks tweets we've already seen so we don't re-classify them.
-- Stores ALL tweets seen from the hiring search (including non-crypto ones),
-- so we skip them on subsequent runs.
CREATE TABLE IF NOT EXISTS seen_tweets (
  tweet_id    TEXT PRIMARY KEY,
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- VIP accounts whose timelines we poll directly (e.g. known crypto firms)
CREATE TABLE IF NOT EXISTS vip_watchlist (
  handle    TEXT PRIMARY KEY,
  user_id   TEXT,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
