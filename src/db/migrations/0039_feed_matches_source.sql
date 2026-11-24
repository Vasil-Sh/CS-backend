-- 0039: which source a feed match came from (Liquipedia ticker / tournament page, PandaScore, Cito, OddsPapi, manual)
-- — for «скільки матчів дає кожне джерело» in the dashboard's «Матчі за 7 днів». Older rows: read from the id prefix.
ALTER TABLE feed_matches ADD COLUMN IF NOT EXISTS source varchar(20);
