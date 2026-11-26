-- 0048: «Telegram-джерела» — what the AI read (to learn from the admin's corrections), who read it and how
-- (ai / rules / channel template / cached slip), the screenshots' hash (the same slip is not read twice),
-- whether the admin corrected the reader, a channel's template trust, private channels read through a Telegram account.
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS ai_raw jsonb;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS ai_by text;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS read_by text;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS img_hash text;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS ai_wrong boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tg_posts_img_hash_idx ON tg_posts(img_hash) WHERE img_hash IS NOT NULL;
--> statement-breakpoint
ALTER TABLE tg_channels ADD COLUMN IF NOT EXISTS template jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE tg_channels ADD COLUMN IF NOT EXISTS private_id text;
--> statement-breakpoint
ALTER TABLE tg_channels ADD COLUMN IF NOT EXISTS invite text;
