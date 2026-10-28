ALTER TABLE banners ADD COLUMN IF NOT EXISTS screen varchar(30) NOT NULL DEFAULT 'matches';
ALTER TABLE banners ADD COLUMN IF NOT EXISTS starts_on date;
ALTER TABLE banners ADD COLUMN IF NOT EXISTS ends_on date;
ALTER TABLE banners ADD CONSTRAINT banners_screen_valid CHECK (screen IN ('matches','journal','analytics','strategies','risky-teams'));
ALTER TABLE banners ADD CONSTRAINT banners_dates_valid CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on);
CREATE TABLE IF NOT EXISTS admin_audit_log (
 id bigserial PRIMARY KEY, actor_id integer NOT NULL, actor_name varchar(200) NOT NULL,
 action varchar(100) NOT NULL, target varchar(200) NOT NULL, details jsonb NOT NULL DEFAULT '{}',
 status varchar(20) NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log(created_at DESC);
