CREATE TABLE IF NOT EXISTS "match_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"match_id" varchar(500) NOT NULL,
	"rating" varchar(20) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "matches_history" (
	"match_id" varchar(500) PRIMARY KEY NOT NULL,
	"game" varchar(20) DEFAULT 'dota2' NOT NULL,
	"team1" varchar(200) NOT NULL,
	"team2" varchar(200) NOT NULL,
	"date" date NOT NULL,
	"score1" integer DEFAULT 0,
	"score2" integer DEFAULT 0,
	"status" varchar(20) DEFAULT 'finished' NOT NULL,
	"tournament" varchar(500) DEFAULT '',
	"match_type" varchar(20) DEFAULT '',
	"logo_team1" varchar(500),
	"logo_team2" varchar(500),
	"tournament_logo" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_bets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"bet_data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tilt_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"until" timestamp NOT NULL,
	"reason" varchar(200) DEFAULT '',
	"strategy_name" varchar(200) DEFAULT '',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bets" ALTER COLUMN "bet_type" SET DATA TYPE varchar(2000);--> statement-breakpoint
ALTER TABLE "bets" ALTER COLUMN "currency" SET DEFAULT 'UAH';--> statement-breakpoint
ALTER TABLE "risky_teams" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_groups" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "max_stake_percent" integer DEFAULT 7;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferences" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "match_ratings" ADD CONSTRAINT "match_ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "telegram_bets" ADD CONSTRAINT "telegram_bets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tilt_blocks" ADD CONSTRAINT "tilt_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "match_ratings_user_idx" ON "match_ratings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "match_ratings_user_match_idx" ON "match_ratings" USING btree ("user_id","match_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matches_history_date_idx" ON "matches_history" USING btree ("date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matches_history_game_idx" ON "matches_history" USING btree ("game");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matches_history_game_date_idx" ON "matches_history" USING btree ("game","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tg_bets_user_idx" ON "telegram_bets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tilt_blocks_user_idx" ON "tilt_blocks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bets_user_result_idx" ON "bets" USING btree ("user_id","result");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bets_goal_id_idx" ON "bets" USING btree ("goal_id");