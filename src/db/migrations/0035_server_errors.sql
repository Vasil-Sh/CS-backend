-- 0035: Server errors kept for the admin («Налаштування → Помилки сервера»): Railway's log is long and scrolls away.
--     One row per kind of error (source + message without numbers): how many times, first and last time, the last details.
CREATE TABLE IF NOT EXISTS server_errors (
  id bigserial PRIMARY KEY,
  key varchar(300) NOT NULL UNIQUE,
  source varchar(30) NOT NULL,
  message text NOT NULL,
  detail text NOT NULL DEFAULT '',
  path varchar(300) NOT NULL DEFAULT '',
  count integer NOT NULL DEFAULT 1,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS server_errors_last_idx ON server_errors(last_at DESC);
