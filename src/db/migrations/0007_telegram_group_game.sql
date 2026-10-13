-- 0007: Add game field to telegram_groups
ALTER TABLE telegram_groups ADD COLUMN IF NOT EXISTS game VARCHAR(20) DEFAULT '';
