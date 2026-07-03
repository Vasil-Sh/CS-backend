-- Fix: change currency default from USD to UAH (the app's primary currency)
-- All existing bets that have currency='USD' but no exchange_rate set
-- were never meant to be USD — they defaulted incorrectly.

-- 1. Update existing data: if currency is 'USD' and no exchange rate,
--    treat as UAH (the app was always UAH-first, USD was a wrong default)
UPDATE bets
SET currency = 'UAH'
WHERE currency = 'USD'
  AND exchange_rate IS NULL;

-- 2. Change column default for new rows
ALTER TABLE bets
ALTER COLUMN currency SET DEFAULT 'UAH';
