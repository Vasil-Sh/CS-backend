-- 0046: «Telegram-джерела» — our own check of every tip: the result by our scores (our_result) next to the channel's (result),
-- a mismatch flag, who settled it, tips placed after the start, deleted / edited posts, express legs; map winners of matches.
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS our_result text;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS settled_by text;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS mismatch boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS is_live boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS edited_at timestamptz;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS legs jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS match_maps (
  key text PRIMARY KEY,               -- game|YYYY-MM-DD|team key 1|team key 2
  game text NOT NULL,
  date date NOT NULL,
  team1 text NOT NULL,
  team2 text NOT NULL,
  winners jsonb NOT NULL,             -- [1, 2, 1]: who won map 1, 2, 3 (team1 / team2)
  source text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS match_maps_date ON match_maps(date);
