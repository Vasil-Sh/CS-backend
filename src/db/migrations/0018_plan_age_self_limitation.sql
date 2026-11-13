-- 0018: Subscription plan as a first-class field + age confirmation + self-limitation requests

-- 1. Plan type on users (trial / basic / pro) + trial end date + age confirmation
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan varchar(20) NOT NULL DEFAULT 'trial' CHECK(plan IN ('trial','basic','pro'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_end_date date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_confirmed boolean NOT NULL DEFAULT false;

-- Backfill plan from price_month (best-effort mapping for existing users).
UPDATE users SET plan = 'pro'    WHERE price_month >= 600 AND plan = 'trial';
UPDATE users SET plan = 'basic'  WHERE price_month > 0 AND price_month < 600 AND plan = 'trial';

-- 2. Self-limitation requests (user asks to pause betting; admin approves/denies)
CREATE TABLE IF NOT EXISTS self_limitation_requests (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username varchar(100) NOT NULL DEFAULT '',
  period_days integer NOT NULL CHECK(period_days > 0),
  reason varchar(500) NOT NULL DEFAULT '',
  status varchar(20) NOT NULL DEFAULT 'new' CHECK(status IN ('new','applied','denied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by varchar(100)
);
CREATE INDEX IF NOT EXISTS self_lim_req_status_idx ON self_limitation_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS self_lim_req_user_idx ON self_limitation_requests(user_id);
