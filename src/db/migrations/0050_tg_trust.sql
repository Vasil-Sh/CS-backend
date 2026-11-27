-- 0050: «Telegram-джерела» — a doubt about a saved tip (the caption, OCR and the AI read it differently),
-- the bookmaker a slip comes from, channels other channels point to (candidates to add),
-- and a seed dictionary of team names as channels write them (Russian / Ukrainian slang, short forms).
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS doubt text;
--> statement-breakpoint
ALTER TABLE tg_posts ADD COLUMN IF NOT EXISTS bookmaker text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tg_candidates (
  handle text PRIMARY KEY,
  seen_in text[] NOT NULL DEFAULT '{}',
  mentions integer NOT NULL DEFAULT 0,
  last_at timestamptz NOT NULL DEFAULT now(),
  dismissed boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
INSERT INTO team_aliases(game, canonical, alias, created_by) VALUES
 ('cs2','Natus Vincere','НАВИ','seed'),('cs2','Natus Vincere','Нави','seed'),('cs2','Natus Vincere','НаВи','seed'),('cs2','Natus Vincere','Наві','seed'),
 ('cs2','Team Spirit','Спирит','seed'),('cs2','Team Spirit','Спириты','seed'),('cs2','Team Spirit','Спірит','seed'),
 ('cs2','Ninjas in Pyjamas','NiP','seed'),('cs2','Ninjas in Pyjamas','Ниндзя','seed'),('cs2','Ninjas in Pyjamas','Ниндзи','seed'),('cs2','Ninjas in Pyjamas','Нип','seed'),
 ('cs2','Team Vitality','Виталити','seed'),('cs2','Team Vitality','Віталіті','seed'),('cs2','Team Vitality','Vita','seed'),
 ('cs2','FaZe Clan','Фейз','seed'),('cs2','FaZe Clan','Фейзы','seed'),('cs2','FaZe Clan','Фейзи','seed'),
 ('cs2','G2 Esports','Джи2','seed'),('cs2','G2 Esports','Джиту','seed'),
 ('cs2','MOUZ','Мауз','seed'),('cs2','MOUZ','Маусы','seed'),('cs2','MOUZ','mousesports','seed'),
 ('cs2','Team Liquid','Ликвид','seed'),('cs2','Team Liquid','Ліквід','seed'),
 ('cs2','HEROIC','Героик','seed'),('cs2','HEROIC','Героїк','seed'),
 ('cs2','Astralis','Астралис','seed'),('cs2','Astralis','Астраліс','seed'),
 ('cs2','FURIA','Фурия','seed'),('cs2','FURIA','Фурія','seed'),
 ('cs2','The MongolZ','Монголы','seed'),('cs2','The MongolZ','Монголз','seed'),('cs2','The MongolZ','MongolZ','seed'),
 ('cs2','Virtus.pro','Виртус','seed'),('cs2','Virtus.pro','Віртус','seed'),('cs2','Virtus.pro','VP','seed'),('cs2','Virtus.pro','Virtus pro','seed'),
 ('cs2','Eternal Fire','Этернал','seed'),('cs2','Eternal Fire','EF','seed'),
 ('cs2','paiN Gaming','Пейн','seed'),('cs2','Complexity','Комплексити','seed'),('cs2','Cloud9','Клауд','seed'),('cs2','Cloud9','C9','seed'),
 ('cs2','BetBoom Team','Бетбум','seed'),('cs2','Team Falcons','Фалконс','seed'),('cs2','Team Falcons','Соколы','seed'),
 ('cs2','Aurora','Аврора','seed'),('cs2','Monte','Монте','seed'),('cs2','B8','Б8','seed'),('cs2','Imperial Esports','Империал','seed'),
 ('cs2','Wildcard','Вайлдкард','seed'),('cs2','Lynn Vision Gaming','Линн','seed'),('cs2','TYLOO','Тайлу','seed'),('cs2','GamerLegion','Геймерлегион','seed'),
 ('dota2','Team Spirit','Спирит','seed'),('dota2','Team Spirit','Спірит','seed'),('dota2','Tundra Esports','Тундра','seed'),
 ('dota2','Gaimin Gladiators','Гладиаторы','seed'),('dota2','Gaimin Gladiators','GG','seed'),('dota2','Xtreme Gaming','Экстрим','seed'),('dota2','Xtreme Gaming','XG','seed'),
 ('dota2','BetBoom Team','Бетбум','seed'),('dota2','BetBoom Team','BB','seed'),('dota2','PARIVISION','Паривижн','seed'),('dota2','Team Falcons','Фалконс','seed'),
 ('dota2','Team Liquid','Ликвид','seed'),('dota2','OG','ОГ','seed'),('dota2','Aurora','Аврора','seed'),('dota2','Natus Vincere','Нави','seed'),('dota2','Nigma Galaxy','Нигма','seed'),
 ('dota2','HEROIC','Героик','seed'),('dota2','Team Secret','Сикрет','seed')
ON CONFLICT (game, alias) DO NOTHING;
