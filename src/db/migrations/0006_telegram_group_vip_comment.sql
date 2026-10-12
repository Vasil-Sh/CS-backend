-- 0006: Add has-channel flag and comment to telegram_groups
ALTER TABLE telegram_groups ADD COLUMN IF NOT EXISTS has_channel BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE telegram_groups ADD COLUMN IF NOT EXISTS comment VARCHAR(500) DEFAULT '';
