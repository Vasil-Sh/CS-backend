-- 0053: «Telegram-джерела» — was a post read right? (the admin's fix or the «Перевірити 10 постів» check)
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS read_wrong boolean;
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS checked_by varchar(100);
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS checked_at timestamptz;
-- the admin's fixes so far: a reader the admin corrected read wrong
UPDATE tg_posts SET read_wrong = true WHERE ai_wrong AND read_wrong IS NULL;
-- a stake 10× above or below the channel's usual (5+ slips in that currency): «Сумнівно»
UPDATE tg_posts p SET doubt = 'Сума ' || trim(to_char(p.stake, 'FM999G999G990D99')) || ' ' || p.currency || ' — у 10+ разів ' ||
       CASE WHEN p.stake > m.med THEN 'більша' ELSE 'менша' END || ', ніж зазвичай у каналу (' || trim(to_char(m.med, 'FM999G999G990D99')) || ')'
  FROM (SELECT handle, currency, percentile_cont(0.5) WITHIN GROUP (ORDER BY stake) AS med, count(*) AS n
          FROM tg_posts WHERE kind = 'bet' AND stake > 0 AND currency IS NOT NULL GROUP BY handle, currency) m
 WHERE p.handle = m.handle AND p.currency = m.currency AND m.n >= 5 AND p.kind = 'bet' AND p.stake > 0
   AND p.doubt IS NULL AND p.fixed_by IS NULL AND (p.stake >= 10 * m.med OR p.stake * 10 <= m.med);
