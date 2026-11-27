-- 0049: «Telegram-джерела» — a post that replies to another post of the channel (its result goes to that tip),
-- and the second, third … bet of one post (an album of slips, «1 карта NAVI, 2 карта Spirit») as rows of their own.
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS reply_to integer;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS part_of integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tg_posts_part_of_idx ON tg_posts(handle, part_of) WHERE part_of IS NOT NULL;
