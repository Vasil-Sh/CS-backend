-- 0047: «Telegram-джерела» — our odds at the time of a tip (a tip with odds far above ours is marked), a channel's own summary
-- («вчора 5/6») next to ours, what a channel usually posts (a hint for the reader), channels paused for silence, failed reads in a row,
-- round scores of each map (map totals / handicaps).
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS our_odds numeric;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS odds_high boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS claim jsonb;
--> statement-breakpoint
ALTER TABLE tg_channels ADD COLUMN IF NOT EXISTS profile jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE tg_channels ADD COLUMN IF NOT EXISTS auto_paused text;
--> statement-breakpoint
ALTER TABLE tg_channels ADD COLUMN IF NOT EXISTS fails integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE match_maps ADD COLUMN IF NOT EXISTS scores jsonb;
