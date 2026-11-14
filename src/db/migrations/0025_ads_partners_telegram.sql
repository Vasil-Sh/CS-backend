-- 0025: Ads — partner details for bookmakers, paid Telegram-group promotions, ad event user id.
ALTER TABLE bookmakers ADD COLUMN IF NOT EXISTS link varchar(500) NOT NULL DEFAULT '';
ALTER TABLE bookmakers ADD COLUMN IF NOT EXISTS button_text varchar(100) NOT NULL DEFAULT '';
ALTER TABLE bookmakers ADD COLUMN IF NOT EXISTS license_until date;
ALTER TABLE bookmakers ADD COLUMN IF NOT EXISTS click_price numeric(10,2);

CREATE TABLE IF NOT EXISTS telegram_promos (
  id bigserial PRIMARY KEY,
  name varchar(100) NOT NULL,
  handle varchar(64) NOT NULL,
  subscribers integer,
  description varchar(300) NOT NULL DEFAULT '',
  placement varchar(20) NOT NULL DEFAULT 'telegram-top' CHECK (placement IN ('telegram-top','match-details')),
  game varchar(20) NOT NULL DEFAULT '',
  starts_on date,
  ends_on date,
  active boolean NOT NULL DEFAULT true,
  review_status varchar(10) NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
  reject_reason varchar(500) NOT NULL DEFAULT '',
  price_note varchar(200) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_promos_dates CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS telegram_promos_live_idx ON telegram_promos(active, review_status);

ALTER TABLE ad_events ADD COLUMN IF NOT EXISTS user_key varchar(64) NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS ad_events_created_idx ON ad_events(created_at DESC);
