-- 0028: Admin «Команди» — teams removed from the directory (a disbanded team still in the logo packs).
--     The directory hides a team whose game + name is listed here; logos and matches are untouched.
CREATE TABLE IF NOT EXISTS hidden_teams (
  id bigserial PRIMARY KEY,
  game varchar(20) NOT NULL,
  name varchar(200) NOT NULL,
  created_by varchar(100) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hidden_teams_game_name UNIQUE (game, name)
);
