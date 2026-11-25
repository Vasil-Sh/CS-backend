-- 0042: «Telegram-джерела» — read every saved post again once: own text only (not the quote of a reply), screenshots scaled up for OCR, repeats marked.
UPDATE tg_posts SET photos = NULL WHERE fixed_by IS NULL;
