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
  bigint,
  smallint,
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
    /** Owner = admin who may also delete/demote admins and appoint owners (migration 0016). */
    isOwner: boolean('is_owner').notNull().default(false),
    telegram: varchar('telegram', { length: 100 }).default(''),
    priceMonth: numeric('price_month', { precision: 10, scale: 2 }).default('0'),
    /** Subscription plan: 'trial' | 'basic' | 'pro' (migration 0018). */
    plan: varchar('plan', { length: 20 }).notNull().default('trial'),
    /** When the trial period ends (null = no trial / already converted). */
    trialEndDate: date('trial_end_date'),
    /** Whether the user's age has been verified. */
    ageConfirmed: boolean('age_confirmed').notNull().default(false),
    /** Telegram chat id captured on /start — used to send receipts. */
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
    startDate: date('start_date').default(sql`CURRENT_DATE`),
    endDate: date('end_date').default(sql`CURRENT_DATE`),
    maxStakePercent: integer('max_stake_percent').default(7),
    birthDate: date('birth_date'),
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
    tournamentLogo: varchar('tournament_logo', { length: 500 }),
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
    hasChannel: boolean('has_channel').default(false).notNull(),
    comment: varchar('comment', { length: 500 }).default(''),
    game: varchar('game', { length: 20 }).default('').notNull(),
    moderationStatus: varchar('moderation_status', { length: 20 }).notNull().default('pending'),
    reviewedBy: varchar('reviewed_by', { length: 100 }),
    reviewedAt: timestamp('reviewed_at'),
    rejectReason: varchar('reject_reason', { length: 500 }),
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
    // 0054: for a predictor — when it started, both teams' ranking then, the odds (last, opening, closing, best) and the maps
    startAt: timestamp('start_at', { withTimezone: true }),
    rank1: integer('rank1'),
    rank2: integer('rank2'),
    coeff1: numeric('coeff1', { precision: 8, scale: 3 }),
    coeff2: numeric('coeff2', { precision: 8, scale: 3 }),
    openCoeff1: numeric('open_coeff1', { precision: 8, scale: 3 }),
    openCoeff2: numeric('open_coeff2', { precision: 8, scale: 3 }),
    closeCoeff1: numeric('close_coeff1', { precision: 8, scale: 3 }),
    closeCoeff2: numeric('close_coeff2', { precision: 8, scale: 3 }),
    bestCoeff1: numeric('best_coeff1', { precision: 8, scale: 3 }),
    bestCoeff2: numeric('best_coeff2', { precision: 8, scale: 3 }),
    bestBook1: varchar('best_book1', { length: 100 }),
    bestBook2: varchar('best_book2', { length: 100 }),
    tier: varchar('tier', { length: 2 }),
    maps: jsonb('maps'),
    // 0055: Polymarket — last prices and the closing line
    pmCoeff1: numeric('pm_coeff1', { precision: 8, scale: 3 }),
    pmCoeff2: numeric('pm_coeff2', { precision: 8, scale: 3 }),
    pmClose1: numeric('pm_close1', { precision: 8, scale: 3 }),
    pmClose2: numeric('pm_close2', { precision: 8, scale: 3 }),
    // 0056: «Ринок Telegram» — the channels' median prices and how many channels priced it
    tgCoeff1: numeric('tg_coeff1', { precision: 8, scale: 3 }),
    tgCoeff2: numeric('tg_coeff2', { precision: 8, scale: 3 }),
    tgChannels: integer('tg_channels'),
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

// ═══════════════════════════════════════════
// Banners — global advertising banners shown on the matches schedule
// ═══════════════════════════════════════════

export const banners = pgTable(
  'banners',
  {
    id: serial('id').primaryKey(),
    active: boolean('active').notNull().default(false),
    slot: smallint('slot').notNull().default(1),
    screen: varchar('screen', { length: 30 }).notNull().default('matches'),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description').default(''),
    imageUrl: varchar('image_url', { length: 500 }).default(''),
    href: varchar('href', { length: 500 }).default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('banners_active_idx').on(table.active)]
);

// ── Per-slot placeholder toggles (independent of banner rows) ──
export const bannerSlots = pgTable('banner_slots', {
  slot: smallint('slot').primaryKey(),
  placeholderEnabled: boolean('placeholder_enabled').notNull().default(false),
});

// ── App settings (admin-managed key/value) ──
export const appSettings = pgTable('app_settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: text('value').notNull().default(''),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

// ═══════════════════════════════════════════
// AI Usage — per-call token + cost accounting (DeepSeek / Gemini)
// ═══════════════════════════════════════════

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    provider: varchar('provider', { length: 20 }).notNull(),
    model: varchar('model', { length: 50 }).notNull().default(''),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    cost: numeric('cost', { precision: 12, scale: 6 }).notNull().default('0'),
    status: varchar('status', { length: 20 }).notNull().default('success'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('ai_usage_created_idx').on(table.createdAt),
    index('ai_usage_user_idx').on(table.userId),
  ]
);

// ═══════════════════════════════════════════
// Parser Failures — persistent scraper/parser failure log
// ═══════════════════════════════════════════

export const parserFailures = pgTable(
  'parser_failures',
  {
    id: serial('id').primaryKey(),
    source: varchar('source', { length: 50 }).notNull(),
    message: text('message').notNull().default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('parser_failures_created_idx').on(table.createdAt),
    index('parser_failures_source_idx').on(table.source),
  ]
);

// ═══════════════════════════════════════════
// Support Tickets — user appeals / contact requests
// ═══════════════════════════════════════════

export const supportTickets = pgTable(
  'support_tickets',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    username: varchar('username', { length: 100 }).notNull().default(''),
    subject: varchar('subject', { length: 200 }).notNull(),
    message: text('message').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('open'),
    resolvedAt: timestamp('resolved_at'),
    resolvedBy: varchar('resolved_by', { length: 100 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('support_tickets_status_idx').on(table.status, table.createdAt),
    index('support_tickets_user_idx').on(table.userId),
  ]
);

// ═══════════════════════════════════════════
// Self-Limitation Requests — user asks to pause betting
// ═══════════════════════════════════════════

export const selfLimitationRequests = pgTable(
  'self_limitation_requests',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    username: varchar('username', { length: 100 }).notNull().default(''),
    periodDays: integer('period_days').notNull(),
    reason: varchar('reason', { length: 500 }).notNull().default(''),
    status: varchar('status', { length: 20 }).notNull().default('new'),
    decidedAt: timestamp('decided_at'),
    decidedBy: varchar('decided_by', { length: 100 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('self_lim_req_status_idx').on(table.status, table.createdAt),
    index('self_lim_req_user_idx').on(table.userId),
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
export type Banner = typeof banners.$inferSelect;
export type NewBanner = typeof banners.$inferInsert;
export type AiUsage = typeof aiUsage.$inferSelect;
export type NewAiUsage = typeof aiUsage.$inferInsert;
export type ParserFailure = typeof parserFailures.$inferSelect;
export type SupportTicket = typeof supportTickets.$inferSelect;
export type NewSupportTicket = typeof supportTickets.$inferInsert;
export type SelfLimitationRequest = typeof selfLimitationRequests.$inferSelect;
export type NewSelfLimitationRequest = typeof selfLimitationRequests.$inferInsert;
export type BannerSlot = typeof bannerSlots.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
