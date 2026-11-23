-- 0033: Admin «Команди → Змінити логотип» — a logo uploaded by an admin. It wins over the logo packs and the feeds
--     everywhere the app shows the team (matches, history, risky teams, profiles). One row per spelling (game + normalized name).
CREATE TABLE IF NOT EXISTS team_logos (
  game varchar(20) NOT NULL,
  norm varchar(200) NOT NULL,
  name varchar(200) NOT NULL,
  mime varchar(30) NOT NULL,
  data bytea NOT NULL,
  updated_by varchar(100) NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game, norm)
);
