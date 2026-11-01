-- 0017: Bumped on password reset/change. Tokens carry the version they were
-- issued with; older tokens stop working, which ends every existing session.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
