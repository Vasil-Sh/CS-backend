-- 0040: «Telegram-джерела» — public t.me channels we read (t.me/s/<handle>) and the posts we parsed into tips.
CREATE TABLE IF NOT EXISTS tg_channels (
  handle varchar(64) PRIMARY KEY,
  title varchar(200),
  subscribers integer,
  game varchar(10) NOT NULL DEFAULT 'both',
  is_test boolean NOT NULL DEFAULT false,
  paused boolean NOT NULL DEFAULT false,
  added_by varchar(100),
  last_post_id integer NOT NULL DEFAULT 0,
  last_post_at timestamptz,
  checked_at timestamptz,
  error varchar(300),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tg_posts (
  handle varchar(64) NOT NULL,
  post_id integer NOT NULL,
  posted_at timestamptz NOT NULL,
  text text NOT NULL,
  kind varchar(10) NOT NULL,
  reason varchar(160),
  game varchar(10),
  match_id varchar(500),
  team1 varchar(200),
  team2 varchar(200),
  market varchar(40),
  pick varchar(200),
  odds numeric(6,2),
  result varchar(10),
  score varchar(10),
  fixed_by varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (handle, post_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tg_posts_kind_idx ON tg_posts(kind, posted_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tg_posts_handle_idx ON tg_posts(handle, posted_at DESC);
