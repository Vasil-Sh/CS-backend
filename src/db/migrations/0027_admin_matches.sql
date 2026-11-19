-- 0026: Admin Matches — manual match edits/creation, merge decisions, team aliases, parser event log.

-- ── Team aliases: canonical name ← variant spelling (e.g. "Natus Vincere" ← "NAVI").
--     Used to recognise the same team across different spellings in feeds and history.
CREATE TABLE IF NOT EXISTS team_aliases (
  id bigserial PRIMARY KEY,
  game varchar(20) NOT NULL DEFAULT '',
  canonical varchar(200) NOT NULL,
  alias varchar(200) NOT NULL,
  created_by varchar(100) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_aliases_game_alias UNIQUE (game, alias)
);
CREATE INDEX IF NOT EXISTS team_aliases_canonical_idx ON team_aliases(game, canonical);

-- ── Manual overrides of feed matches (status / time / score) keyed by game + source id.
--     The admin "ручні правки" panel writes here; the feed applies these on read.
CREATE TABLE IF NOT EXISTS match_overrides (
  id bigserial PRIMARY KEY,
  game varchar(20) NOT NULL,
  match_id varchar(500) NOT NULL,
  status varchar(20),
  start_date timestamptz,
  score1 integer,
  score2 integer,
  decided_by varchar(100) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_overrides_game_match UNIQUE (game, match_id)
);

-- ── Manually created matches (admin "Додати матч"), merged into the schedule feed.
CREATE TABLE IF NOT EXISTS manual_matches (
  id varchar(100) PRIMARY KEY,
  game varchar(20) NOT NULL,
  team1 varchar(200) NOT NULL,
  team2 varchar(200) NOT NULL,
  tournament varchar(500) NOT NULL DEFAULT '',
  bo varchar(20) NOT NULL DEFAULT '',
  start_date timestamptz NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'upcoming',
  score1 integer,
  score2 integer,
  created_by varchar(100) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS manual_matches_game_date_idx ON manual_matches(game, start_date);

-- ── Merge decisions: link a user-entered match (team1+team2+date) to an official match.
--     decision: 'merged' (об'єднати) | 'different' (це інший матч).
CREATE TABLE IF NOT EXISTS match_links (
  id bigserial PRIMARY KEY,
  game varchar(20) NOT NULL,
  team1 varchar(200) NOT NULL,
  team2 varchar(200) NOT NULL,
  match_date date NOT NULL,
  link_key varchar(500) NOT NULL,
  official_id varchar(500),
  decision varchar(20) NOT NULL DEFAULT 'pending',
  decided_by varchar(100) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_links_key UNIQUE (link_key)
);
CREATE INDEX IF NOT EXISTS match_links_game_idx ON match_links(game, match_date);

-- ── Parser events: full log (success + failure + manual rerun) for the «повний лог».
CREATE TABLE IF NOT EXISTS parser_events (
  id bigserial PRIMARY KEY,
  source varchar(50) NOT NULL,
  event varchar(20) NOT NULL DEFAULT 'failure',
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parser_events_created_idx ON parser_events(created_at DESC);
CREATE INDEX IF NOT EXISTS parser_events_source_idx ON parser_events(source, created_at DESC);
