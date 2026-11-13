-- 0023: «Log out on all devices» — tokens issued before this moment are rejected.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_revoked_at timestamptz;
