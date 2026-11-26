-- 0044: «Telegram-джерела» — what the bet slip on a screenshot shows: its state (won / lost / pending / cashout / void) and the money on it.
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS slip text;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS stake numeric;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS currency text;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS payout numeric;
--> statement-breakpoint
-- read every post once more with the new reader (map bets as tips, slip results and money)
UPDATE tg_posts SET photos = NULL WHERE fixed_by IS NULL;
