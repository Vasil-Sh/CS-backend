-- 0043: «Telegram-джерела» — read saved posts again once more: better OCR (4 passes), teams written in the post when the match is not in our feed, «Match Winner», Cyrillic look-alikes.
UPDATE tg_posts SET photos = NULL WHERE fixed_by IS NULL;
