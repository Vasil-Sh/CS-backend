-- 0005: Add banners table for advertising campaigns on the matches schedule
CREATE TABLE IF NOT EXISTS banners (
  id SERIAL PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT false,
  title VARCHAR(200) NOT NULL,
  description TEXT DEFAULT '',
  image_url VARCHAR(500) DEFAULT '',
  href VARCHAR(500) DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS banners_active_idx ON banners(active);
