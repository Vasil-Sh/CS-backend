-- 0026: Columns the app's schema expects but older production databases may lack.
-- Bank in dollars (bankroll) and the original $ stake/profit + rate of dollar bets. Safe to re-run.
ALTER TABLE bankroll ADD COLUMN IF NOT EXISTS initial_bank_usd numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE bankroll ADD COLUMN IF NOT EXISTS exchange_rate numeric(8,2) NOT NULL DEFAULT 0;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS original_amount numeric(12,2);
ALTER TABLE bets ADD COLUMN IF NOT EXISTS exchange_rate numeric(10,4);
ALTER TABLE bets ADD COLUMN IF NOT EXISTS original_profit numeric(12,2);
