-- 0054: a finished match keeps what a predictor needs — the start time, both teams' ranking then, the odds and the maps
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS start_at timestamptz;
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS rank1 integer;
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS rank2 integer;
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS coeff1 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS coeff2 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS open_coeff1 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS open_coeff2 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS close_coeff1 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS close_coeff2 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS best_coeff1 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS best_coeff2 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS best_book1 varchar(100);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS best_book2 varchar(100);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS tier varchar(2);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS maps jsonb;
