-- 0055: Polymarket's prices of a finished match — the last ones seen and the closing line (before the start)
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS pm_coeff1 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS pm_coeff2 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS pm_close1 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS pm_close2 numeric(8, 3);
