-- Migration: Add CHECK constraints for enum-like fields
-- Run with: psql $DATABASE_URL -f backend/src/db/migrations/0001_check_constraints.sql

-- Bets.result: only 'Win', 'Loss', 'Pending'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bets_result_check') THEN
    ALTER TABLE bets ADD CONSTRAINT bets_result_check CHECK (result IN ('Win', 'Loss', 'Pending'));
  END IF;
END $$;

-- Users.role: only 'admin', 'user'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'user'));
  END IF;
END $$;

-- Goals.type: only known goal types
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goals_type_check') THEN
    ALTER TABLE goals ADD CONSTRAINT goals_type_check CHECK (type IN ('amount', 'ladder', 'roi', 'winrate', 'win_rate'));
  END IF;
END $$;

-- Composite index: bets (user_id, result) for stats queries
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'bets_user_result_idx') THEN
    CREATE INDEX bets_user_result_idx ON bets(user_id, result);
  END IF;
END $$;

-- Index on bets.goal_id for goal filtering
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'bets_goal_id_idx') THEN
    CREATE INDEX bets_goal_id_idx ON bets(goal_id) WHERE goal_id IS NOT NULL AND goal_id != '';
  END IF;
END $$;

-- Add updatedAt to risky_teams and telegram_groups (if missing)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'risky_teams' AND column_name = 'updated_at') THEN
    ALTER TABLE risky_teams ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'telegram_groups' AND column_name = 'updated_at') THEN
    ALTER TABLE telegram_groups ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;
END $$;
