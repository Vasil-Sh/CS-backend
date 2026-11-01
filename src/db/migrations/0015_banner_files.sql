-- 0015: Store uploaded banner images in Postgres instead of the container disk.
-- Files written to .cache/banners were lost on every Railway redeploy
-- (no persistent volume), leaving broken banner images on the site.
CREATE TABLE IF NOT EXISTS banner_files (
  filename VARCHAR(100) PRIMARY KEY,
  mime VARCHAR(50) NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
