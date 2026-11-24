-- 0037: one row per match the feed has shown (from the 2-minute refresh) — for the dashboard's «Матчі за 7 днів»:
-- how many were collected, how many finished without a score, how many had odds.
CREATE TABLE IF NOT EXISTS feed_matches (
  id varchar(200) PRIMARY KEY,
  game varchar(10) NOT NULL,
  date date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'upcoming',
  has_score boolean NOT NULL DEFAULT false,
  has_odds boolean NOT NULL DEFAULT false,
  first_seen timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_matches_date_idx ON feed_matches(date);
