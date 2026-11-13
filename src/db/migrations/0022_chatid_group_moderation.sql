-- 0022: Telegram chat_id for receipts + telegram group moderation

-- 1. Store the user's Telegram chat id (captured on /start) for sending receipts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id bigint;

-- 2. Telegram group moderation fields.
ALTER TABLE telegram_groups ADD COLUMN IF NOT EXISTS moderation_status varchar(20) NOT NULL DEFAULT 'approved' CHECK(moderation_status IN ('pending','approved','rejected'));
ALTER TABLE telegram_groups ADD COLUMN IF NOT EXISTS reviewed_by varchar(100);
ALTER TABLE telegram_groups ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE telegram_groups ADD COLUMN IF NOT EXISTS reject_reason varchar(500);

-- New groups start as pending until an admin approves them.
ALTER TABLE telegram_groups ALTER COLUMN moderation_status SET DEFAULT 'pending';
