-- 0036: «Стоп на 1 год / до ранку»: a stopped parser starts itself again at paused_until (NULL = until started by hand).
ALTER TABLE parser_pauses ADD COLUMN IF NOT EXISTS paused_until timestamptz;

-- What changed in a match and which source changed it (time, status, score, odds) — the match sheet in the admin shows it.
CREATE TABLE IF NOT EXISTS match_changes (
  id bigserial PRIMARY KEY,
  game varchar(10) NOT NULL,
  match_id varchar(200) NOT NULL,
  field varchar(30) NOT NULL,
  old_value text,
  new_value text,
  source varchar(40) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_changes_match_idx ON match_changes(match_id, created_at DESC);
CREATE INDEX IF NOT EXISTS match_changes_created_idx ON match_changes(created_at);

-- Closing line (last prices before the start) per match — the journal compares a bet's odds with it.
CREATE TABLE IF NOT EXISTS closing_lines (
  match_id varchar(200) PRIMARY KEY,
  game varchar(10) NOT NULL,
  team1 varchar(200) NOT NULL,
  team2 varchar(200) NOT NULL,
  date date NOT NULL,
  close1 numeric(8,3) NOT NULL,
  close2 numeric(8,3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS closing_lines_date_idx ON closing_lines(date);
