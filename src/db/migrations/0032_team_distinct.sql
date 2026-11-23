-- 0032: Admin «Команди → Дублікати» — «Різні команди»: a spelling from the feeds that is NOT this team.
--     The directory stops flagging the pair as a possible duplicate; matches and logos are untouched.
CREATE TABLE IF NOT EXISTS team_distinct (
  id bigserial PRIMARY KEY,
  game varchar(20) NOT NULL,
  name varchar(200) NOT NULL,
  variant varchar(200) NOT NULL,
  created_by varchar(100) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_distinct_pair UNIQUE (game, name, variant)
);
