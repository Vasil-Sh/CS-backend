-- 0041: «Telegram-джерела» — screenshots of a post (t.me CDN links) and the text OCR read on them.
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS photos text[];
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS ocr text;
