-- 0009: Add banner_slots table for per-slot placeholder toggles
CREATE TABLE IF NOT EXISTS banner_slots (
  slot SMALLINT PRIMARY KEY,
  placeholder_enabled BOOLEAN NOT NULL DEFAULT false
);
