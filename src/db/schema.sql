-- Viral tweet detection schema

CREATE TABLE IF NOT EXISTS tweets (
  tweet_id        TEXT PRIMARY KEY,
  author_handle   TEXT NOT NULL DEFAULT '',
  author_name     TEXT NOT NULL DEFAULT '',
  tweet_text      TEXT,
  likes           INTEGER NOT NULL DEFAULT 0,
  retweets        INTEGER NOT NULL DEFAULT 0,
  replies         INTEGER NOT NULL DEFAULT 0,
  views           INTEGER NOT NULL DEFAULT 0,
  bookmarks       INTEGER NOT NULL DEFAULT 0,
  quotes          INTEGER NOT NULL DEFAULT 0,
  posted_at       TIMESTAMPTZ,
  first_detected  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tweet_url       TEXT,
  has_media       BOOLEAN NOT NULL DEFAULT FALSE,
  media_type      TEXT,
  -- Growth fields updated by scheduler
  status          TEXT NOT NULL DEFAULT 'normal',  -- normal | warming | fast | parabolic | fading
  likes_per_hour  NUMERIC NOT NULL DEFAULT 0,
  views_per_hour  NUMERIC NOT NULL DEFAULT 0,
  acceleration    NUMERIC NOT NULL DEFAULT 0,       -- change in likes_per_hour over last interval
  engagement_rate NUMERIC NOT NULL DEFAULT 0,       -- likes/views * 100
  rt_ratio        NUMERIC NOT NULL DEFAULT 0,       -- retweets/likes * 100
  virality_score  NUMERIC NOT NULL DEFAULT 0
);

-- Migrate existing DBs: add new columns if they don't exist yet
ALTER TABLE tweets ADD COLUMN IF NOT EXISTS acceleration    NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE tweets ADD COLUMN IF NOT EXISTS engagement_rate NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE tweets ADD COLUMN IF NOT EXISTS rt_ratio        NUMERIC NOT NULL DEFAULT 0;

-- Time-series snapshots for growth calculation
CREATE TABLE IF NOT EXISTS tweet_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  tweet_id    TEXT NOT NULL REFERENCES tweets(tweet_id) ON DELETE CASCADE,
  likes       INTEGER NOT NULL DEFAULT 0,
  retweets    INTEGER NOT NULL DEFAULT 0,
  replies     INTEGER NOT NULL DEFAULT 0,
  views       INTEGER NOT NULL DEFAULT 0,
  bookmarks   INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_tweet_id     ON tweet_snapshots(tweet_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_recorded_at  ON tweet_snapshots(recorded_at);
CREATE INDEX IF NOT EXISTS idx_tweets_status          ON tweets(status);
CREATE INDEX IF NOT EXISTS idx_tweets_posted_at       ON tweets(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_likes           ON tweets(likes DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_virality        ON tweets(virality_score DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_acceleration    ON tweets(acceleration DESC);

-- Handle blacklist (display-side filter; crawling continues unaffected)
CREATE TABLE IF NOT EXISTS blacklist (
  handle    TEXT PRIMARY KEY,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
