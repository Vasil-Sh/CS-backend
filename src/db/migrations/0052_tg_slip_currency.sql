-- slips whose sum was read without its sign: the channel's one currency (3+ slips, 90%+ of them in it)
UPDATE tg_posts p SET currency = m.currency
  FROM (SELECT handle, currency FROM (
          SELECT handle, currency, count(*) AS n, sum(count(*)) OVER (PARTITION BY handle) AS total
            FROM tg_posts WHERE currency IS NOT NULL GROUP BY handle, currency) x
         WHERE n >= 3 AND n >= 0.9 * total) m
 WHERE p.handle = m.handle AND p.currency IS NULL AND p.stake IS NOT NULL AND p.kind = 'bet';
