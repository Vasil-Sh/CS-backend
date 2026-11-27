-- 0051: «Telegram-джерела» — the closing odds of a tip's match (the last price before the start, for CLV).
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS closing_odds numeric(8,3);
