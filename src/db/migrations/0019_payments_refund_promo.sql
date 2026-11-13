-- 0019: Payments v2 — refunds, payment method, promo codes

-- 1. Payment method + refund fields on admin_payments
ALTER TABLE admin_payments ADD COLUMN IF NOT EXISTS payment_method varchar(50) NOT NULL DEFAULT '';
ALTER TABLE admin_payments ADD COLUMN IF NOT EXISTS refunded_amount numeric(12,2);
ALTER TABLE admin_payments ADD COLUMN IF NOT EXISTS refund_reason varchar(500);
ALTER TABLE admin_payments ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE admin_payments ADD COLUMN IF NOT EXISTS refunded_by varchar(100);
ALTER TABLE admin_payments ADD COLUMN IF NOT EXISTS promo_code varchar(100) NOT NULL DEFAULT '';

-- Relax status check to allow 'refunded' (drop + re-add).
ALTER TABLE admin_payments DROP CONSTRAINT IF EXISTS admin_payments_status_check;
ALTER TABLE admin_payments ADD CONSTRAINT admin_payments_status_check
  CHECK(status IN ('recorded','cancelled','refunded'));

-- 2. Promo codes
CREATE TABLE IF NOT EXISTS promo_codes (
  id bigserial PRIMARY KEY,
  code varchar(100) NOT NULL UNIQUE,
  discount_percent integer NOT NULL CHECK(discount_percent > 0 AND discount_percent <= 100),
  plan varchar(20) NOT NULL DEFAULT 'basic' CHECK(plan IN ('trial','basic','pro')),
  starts_on date,
  ends_on date,
  usage_limit integer,
  used_count integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promo_codes_code_idx ON promo_codes(code);
