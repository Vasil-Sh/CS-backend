-- 0004: Add tilt_blocks table for per-user loss streak protection
CREATE TABLE IF NOT EXISTS tilt_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  until TIMESTAMP NOT NULL,
  reason VARCHAR(200) DEFAULT '',
  strategy_name VARCHAR(200) DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tilt_blocks_user_idx ON tilt_blocks(user_id);
