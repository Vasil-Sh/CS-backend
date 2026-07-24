// Create matches_history table directly in PostgreSQL
const { Pool } = require('pg');
require('dotenv/config');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
CREATE TABLE IF NOT EXISTS matches_history (
  match_id varchar(500) PRIMARY KEY NOT NULL,
  game varchar(20) DEFAULT 'dota2' NOT NULL,
  team1 varchar(200) NOT NULL,
  team2 varchar(200) NOT NULL,
  date date NOT NULL,
  score1 integer DEFAULT 0,
  score2 integer DEFAULT 0,
  status varchar(20) DEFAULT 'finished' NOT NULL,
  tournament varchar(500) DEFAULT '',
  match_type varchar(20) DEFAULT '',
  logo_team1 varchar(500),
  logo_team2 varchar(500),
  tournament_logo varchar(500),
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS matches_history_date_idx ON matches_history(date);
CREATE INDEX IF NOT EXISTS matches_history_game_idx ON matches_history(game);
CREATE INDEX IF NOT EXISTS matches_history_game_date_idx ON matches_history(game, date);
`;

async function main() {
  try {
    await pool.query(SQL);
    console.log('[migrate] matches_history table created');
  } catch (err) {
    console.error('[migrate]', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
