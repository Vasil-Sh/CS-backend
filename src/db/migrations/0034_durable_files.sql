-- 0034: Railway's disk is wiped on every deploy. Caches that are costly to rebuild (the merged match lists,
--     the HLTV logo map, tournament logos) are copied here and put back on start.
CREATE TABLE IF NOT EXISTS durable_files (
  name varchar(300) PRIMARY KEY,
  data bytea NOT NULL,
  mtime_ms bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
