CREATE TABLE IF NOT EXISTS admin_payments (
 id bigserial PRIMARY KEY, request_id uuid NOT NULL UNIQUE,
 user_id integer REFERENCES users(id) ON DELETE SET NULL, username varchar(100) NOT NULL,
 amount numeric(12,2) NOT NULL CHECK(amount>0), currency varchar(3) NOT NULL DEFAULT 'UAH' CHECK(currency='UAH'),
 paid_on date NOT NULL, period_start date NOT NULL, period_end date NOT NULL CHECK(period_end>=period_start),
 note varchar(1000) NOT NULL DEFAULT '', extend_subscription boolean NOT NULL DEFAULT false,
 created_by integer NOT NULL, created_by_name varchar(100) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 status varchar(20) NOT NULL DEFAULT 'recorded' CHECK(status IN ('recorded','cancelled')),
 cancelled_by_name varchar(100), cancelled_at timestamptz, cancel_reason varchar(500)
);
CREATE INDEX IF NOT EXISTS admin_payments_user_idx ON admin_payments(user_id,paid_on DESC,id DESC);
CREATE INDEX IF NOT EXISTS admin_payments_date_idx ON admin_payments(paid_on) WHERE status='recorded';
