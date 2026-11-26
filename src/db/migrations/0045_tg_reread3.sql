-- 0045: «Telegram-джерела» — read the posts once more: app screenshots (tables, forms) are not tips, slip states from their own words, a result post keeps its own slip.
UPDATE tg_posts SET photos = NULL WHERE fixed_by IS NULL;
