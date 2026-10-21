-- 0008: Add slot column to banners (1 = top between live/upcoming, 2 = before finished)
ALTER TABLE banners ADD COLUMN IF NOT EXISTS slot SMALLINT NOT NULL DEFAULT 1;
