-- 0024: admin actions on a subscription — temporary Pro grant and cancellation.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_until date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_base_plan varchar(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cancelled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cancel_mode varchar(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cancel_reason varchar(500);
