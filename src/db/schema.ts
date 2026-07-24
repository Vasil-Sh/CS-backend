import {
  pgTable,
  serial,
  varchar,
  text,
  numeric,
  date,
  timestamp,
  uuid,
  boolean,
  jsonb,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ═══════════════════════════════════════════
// Users
// ═══════════════════════════════════════════

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    username: varchar('username', { length: 100 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role: varchar('role', { length: 20 }).notNull().default('user'),
    telegram: varchar('telegram', { length: 100 }).default(''),
    priceMonth: numeric('price_month', { precision: 10, scale: 2 }).default('0'),
    startDate: date('start_date').default(sql`CURRENT_DATE`),
    endDate: date('end_date').default(sql`CURRENT_DATE`),
    maxStakePercent: integer('max_stake_percent').default(7),
    preferences: jsonb('preferences').$type<{ theme?: string; lang?: string }>().default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex('users_username_idx').on(table.username)]
);

// ═══════════════════════════════════════════
// Bets
// ═══════════════════════════════════════════

export const bets = pgTable(
  'bets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    match: varchar('match', { length: 500 }).notNull(),
    team1: varchar('team1', { length: 200 }).default(''),
    team2: varchar('team2', { length: 200 }).default(''),
    betType: varchar('bet_type', { length: 2000 }).notNull().default('Ординар'),
    odds: numeric('odds', { precision: 10, scale: 3 }).notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    stake: numeric('stake', { precision: 12, scale: 2 }),
    date: date('date').notNull().default(sql`CURRENT_DATE`),
    result: varchar('result', { length: 20 }).notNull().default('Pending'), // 'Win' | 'Loss' | 'Pending'

    profit: numeric('profit', { precision: 12, scale: 2 }).default('0'),
    strategy: varchar('strategy', { length: 200 }).default(''),
    format: varchar('format', { length: 20 }).default(''),
    game: varchar('game', { length: 20 }).default('CS2'),
    currency: varchar('currency', { length: 10 }).default('UAH'),

    originalAmount: numeric('original_amount', { precision: 12, scale: 2 }),
    exchangeRate: numeric('exchange_rate', { precision: 10, scale: 4 }),
    originalProfit: numeric('original_profit', { precision: 12, scale: 2 }),
    roi: numeric('roi', { precision: 8, scale: 2 }),

    goalId: varchar('goal_id', { length: 100 }),
    selection: varchar('selection', { length: 200 }).default(''),
    matchUrl: varchar('match_url', { length: 500 }).default(''),
    winProbability: numeric('win_probability', { precision: 5, scale: 2 }),

    risk: varchar('risk', { length: 50 }).default(''),
    notes: text('notes').default(''),
    riskyTeams: jsonb('risky_teams').$type<string[]>().default([]),
    tournament: varchar('tournament', { length: 200 }).default(''),

    logoTeam1: varchar('logo_team1', { length: 500 }),
    logoTeam2: varchar('logo_team2', { length: 500 }),
    expressLogos: jsonb('express_logos')
      .$type<{ logoTeam1?: string | null; logoTeam2?: string | null }[]>()
      .default([]),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('bets_user_id_idx').on(table.userId),
    index('bets_date_idx').on(table.date),
    index('bets_result_idx').on(table.result),
    index('bets_user_result_idx').on(table.userId, table.result),
    index('bets_goal_id_idx').on(table.goalId),
  ]
);

// ═══════════════════════════════════════════
// Goals
// ═══════════════════════════════════════════

export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    type: varchar('type', { length: 50 }).notNull(), // 'amount' | 'ladder' | 'roi' | 'win_rate'
    name: varchar('name', { length: 200 }).default(''),
    target: numeric('target', { precision: 12, scale: 2 }).notNull(),
    current: numeric('current', { precision: 12, scale: 2 }).default('0'),
    deadline: date('deadline'),
    isCompleted: boolean('is_completed').default(false),
    config: jsonb('config').default({}),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('goals_user_id_idx').on(table.userId)]
);

// ═══════════════════════════════════════════
// Strategies
// ═══════════════════════════════════════════

export const strategies = pgTable(
  'strategies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: varchar('name', { length: 200 }).notNull(),
    isPrimary: boolean('is_primary').default(false),
    config: jsonb('config').notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('strategies_user_id_idx').on(table.userId)]
);

// ═══════════════════════════════════════════
// Bankroll
// ═══════════════════════════════════════════

export const bankroll = pgTable(
  'bankroll',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),

    initialBank: numeric('initial_bank', { precision: 12, scale: 2 }).notNull().default('0'),
    initialBankUSD: numeric('initial_bank_usd', { precision: 12, scale: 2 }).notNull().default('0'),
    exchangeRate: numeric('exchange_rate', { precision: 8, scale: 2 }).notNull().default('0'),
    manualAdjustments: numeric('manual_adjustments', { precision: 12, scale: 2 }).default('0'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('bankroll_user_id_idx').on(table.userId)]
);

// ═══════════════════════════════════════════
// Risky Teams (admin-managed)
// ═══════════════════════════════════════════

export const riskyTeams = pgTable(
  'risky_teams',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().default(1).references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    game: varchar('game', { length: 20 }).default(''),
    status: varchar('status', { length: 50 }).default(''),
    notes: text('notes').default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('risky_teams_name_idx').on(table.name),
    index('risky_teams_user_idx').on(table.userId),
    uniqueIndex('risky_teams_user_name_idx').on(table.userId, table.name),
  ]
);

// ═══════════════════════════════════════════
// Telegram Groups (per-user)
// ═══════════════════════════════════════════

export const telegramGroups = pgTable(
  'telegram_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    link: varchar('link', { length: 500 }).default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('tg_groups_user_idx').on(table.userId)]
);

// ═══════════════════════════════════════════
// Telegram Bets (received via Telegram bot)
// ═══════════════════════════════════════════

export const telegramBets = pgTable(
  'telegram_bets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    betData: jsonb('bet_data').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('tg_bets_user_idx').on(table.userId)]
);

// ═══════════════════════════════════════════
// Match Ratings (user like/dislike on matches)
// ═══════════════════════════════════════════

export const matchRatings = pgTable(
  'match_ratings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    matchId: varchar('match_id', { length: 500 }).notNull(),
    rating: varchar('rating', { length: 20 }).notNull(), // 'like' | 'dislike'
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('match_ratings_user_idx').on(table.userId),
    uniqueIndex('match_ratings_user_match_idx').on(table.userId, table.matchId),
  ]
);

// ═══════════════════════════════════════════
// Tilt Blocks (per-user loss streak protection)
// ═══════════════════════════════════════════

export const tiltBlocks = pgTable(
  'tilt_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    until: timestamp('until').notNull(),
    reason: varchar('reason', { length: 200 }).default(''),
    strategyName: varchar('strategy_name', { length: 200 }).default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('tilt_blocks_user_idx').on(table.userId)]
);

// ═══════════════════════════════════════════
// Matches History — persistent storage of finished matches
// ═══════════════════════════════════════════

export const matchesHistory = pgTable(
  'matches_history',
  {
    id: varchar('match_id', { length: 500 }).primaryKey(),
    game: varchar('game', { length: 20 }).notNull().default('dota2'),
    team1: varchar('team1', { length: 200 }).notNull(),
    team2: varchar('team2', { length: 200 }).notNull(),
    date: date('date').notNull(),
    score1: integer('score1').default(0),
    score2: integer('score2').default(0),
    status: varchar('status', { length: 20 }).notNull().default('finished'),
    tournament: varchar('tournament', { length: 500 }).default(''),
    matchType: varchar('match_type', { length: 20 }).default(''),
    logoTeam1: varchar('logo_team1', { length: 500 }),
    logoTeam2: varchar('logo_team2', { length: 500 }),
    tournamentLogo: varchar('tournament_logo', { length: 500 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('matches_history_date_idx').on(table.date),
    index('matches_history_game_idx').on(table.game),
    index('matches_history_game_date_idx').on(table.game, table.date),
  ]
);

// ── Type exports ──

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Bet = typeof bets.$inferSelect;
export type NewBet = typeof bets.$inferInsert;
export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
export type Strategy = typeof strategies.$inferSelect;
export type NewStrategy = typeof strategies.$inferInsert;
export type BankrollEntry = typeof bankroll.$inferSelect;
export type NewBankrollEntry = typeof bankroll.$inferInsert;
export type RiskyTeam = typeof riskyTeams.$inferSelect;
export type TiltBlock = typeof tiltBlocks.$inferSelect;
export type MatchHistory = typeof matchesHistory.$inferSelect;
export type NewMatchHistory = typeof matchesHistory.$inferInsert;
