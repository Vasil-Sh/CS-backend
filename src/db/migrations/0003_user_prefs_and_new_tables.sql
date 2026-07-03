-- 0003: Add preferences + max_stake_percent to users, new tables telegram_bets + match_ratings

-- 1. Add columns to users
ALTER TABLE users
ADD COLUMN IF NOT EXISTS max_stake_percent INTEGER DEFAULT 7,
ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}';

-- 2. Create telegram_bets table
CREATE TABLE IF NOT EXISTS telegram_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bet_data JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tg_bets_user_idx ON telegram_bets(user_id);

-- 3. Create match_ratings table
CREATE TABLE IF NOT EXISTS match_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id VARCHAR(500) NOT NULL,
  rating VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_ratings_user_idx ON match_ratings(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS match_ratings_user_match_idx ON match_ratings(user_id, match_id);
