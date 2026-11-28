-- 0056: «Ринок Telegram» of a finished match — the channels' median price on each team and how many channels priced it
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS tg_coeff1 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS tg_coeff2 numeric(8, 3);
ALTER TABLE matches_history ADD COLUMN IF NOT EXISTS tg_channels integer;
