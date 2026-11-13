-- 0020: Sessions tracking (for "log out on other devices" and session list)

CREATE TABLE IF NOT EXISTS sessions (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_jti varchar(64) NOT NULL UNIQUE,
  ip varchar(64) NOT NULL DEFAULT '',
  user_agent varchar(500) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, last_seen_at DESC);
