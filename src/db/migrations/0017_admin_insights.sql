-- 0017: Admin insights — AI usage, parser failures, support tickets, user birth date

-- 1. Age verification (birth date on users)
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;

-- 2. AI usage tracking (tokens + cost per AI call)
CREATE TABLE IF NOT EXISTS ai_usage (
  id bigserial PRIMARY KEY,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  provider varchar(20) NOT NULL,            -- 'deepseek' | 'gemini'
  model varchar(50) NOT NULL DEFAULT '',
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost numeric(12,6) NOT NULL DEFAULT 0,     -- USD
  status varchar(20) NOT NULL DEFAULT 'success' CHECK(status IN ('success','error')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_created_idx ON ai_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_user_idx ON ai_usage(user_id);

-- 3. Parser / scraper failures (persistent, replaces in-memory-only circuit breaker state)
CREATE TABLE IF NOT EXISTS parser_failures (
  id bigserial PRIMARY KEY,
  source varchar(50) NOT NULL,              -- circuit breaker name (tipsgg, hltv, …)
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parser_failures_created_idx ON parser_failures(created_at DESC);
CREATE INDEX IF NOT EXISTS parser_failures_source_idx ON parser_failures(source);

-- 4. Support tickets / user appeals
CREATE TABLE IF NOT EXISTS support_tickets (
  id bigserial PRIMARY KEY,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  username varchar(100) NOT NULL DEFAULT '',
  subject varchar(200) NOT NULL,
  message text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by varchar(100)
);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_user_idx ON support_tickets(user_id);
