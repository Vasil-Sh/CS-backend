-- 0021: Support status, bookmakers, ad impressions/clicks

-- 1. Support tickets: add 'in_progress' status
ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_status_check;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_status_check
  CHECK(status IN ('open','in_progress','resolved','closed'));

-- 2. Bookmakers (licensed partners)
CREATE TABLE IF NOT EXISTS bookmakers (
  id bigserial PRIMARY KEY,
  name varchar(100) NOT NULL,
  license_number varchar(100) NOT NULL DEFAULT '',
  moderation_text varchar(2000) NOT NULL DEFAULT '',
  show_odds_in_list boolean NOT NULL DEFAULT false,
  show_match_details boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Ad impressions/clicks (per placement)
CREATE TABLE IF NOT EXISTS ad_events (
  id bigserial PRIMARY KEY,
  placement varchar(50) NOT NULL,
  entity_id varchar(100) NOT NULL DEFAULT '',
  kind varchar(10) NOT NULL CHECK(kind IN ('impression','click')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_events_placement_idx ON ad_events(placement, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_events_kind_idx ON ad_events(kind);

-- 4. Support reply templates
CREATE TABLE IF NOT EXISTS support_templates (
  id bigserial PRIMARY KEY,
  title varchar(200) NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
