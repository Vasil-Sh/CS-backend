-- 0030: Admin «Матчі → Парсери» — parsers stopped by hand. A stopped parser does not fetch
--     (the app keeps the last saved data) and does not count failures, until it is started again.
CREATE TABLE IF NOT EXISTS parser_pauses (
  name varchar(100) PRIMARY KEY,
  paused_by varchar(100) NOT NULL DEFAULT '',
  paused_at timestamptz NOT NULL DEFAULT now()
);
