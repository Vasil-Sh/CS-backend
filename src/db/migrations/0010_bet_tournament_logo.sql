-- 0010: Add tournament_logo column to bets
ALTER TABLE bets ADD COLUMN IF NOT EXISTS tournament_logo VARCHAR(500);
