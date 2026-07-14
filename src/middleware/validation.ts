import { z } from 'zod';

// ═══════════════════════════════════════════
// Auth schemas
// ═══════════════════════════════════════════

export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required').max(100),
  password: z.string().min(4, 'Password must be at least 4 characters').max(255),
});

export const registerSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().optional(),
  telegram: z.string().optional(),
  priceMonth: z.string().optional(),
  endDate: z.string().optional(),
  role: z.enum(['admin', 'user']).optional(),
});

// ═══════════════════════════════════════════
// Bet schemas
// ═══════════════════════════════════════════

export const createBetSchema = z.object({
  match: z.string().min(1).max(500),
  team1: z.string().max(200).optional().default(''),
  team2: z.string().max(200).optional().default(''),
  betType: z.string().max(2000).default('Ординар'),
  odds: z.coerce.number().min(0).max(1000),
  amount: z.coerce.number().min(0),
  stake: z.coerce.number().optional(),
  date: z.string().optional(),
  result: z.enum(['Win', 'Loss', 'Pending']).default('Pending'),
  profit: z.coerce.number().optional(),
  strategy: z.string().max(200).optional().default(''),
  format: z.string().max(20).optional().default(''),
  game: z.string().max(20).default('CS2'),
  currency: z.string().max(10).default('UAH'),
  originalAmount: z.coerce.number().optional(),
  exchangeRate: z.coerce.number().optional().nullable(),
  originalProfit: z.coerce.number().optional(),
  roi: z.coerce.number().optional(),
  goalId: z.string().optional().default(''),
  selection: z.string().max(200).optional().default(''),
  matchUrl: z.string().max(500).optional().default(''),
  winProbability: z.coerce.number().min(0).max(100).optional(),
  risk: z.string().max(50).optional().default(''),
  notes: z.string().optional().default(''),
  riskyTeams: z.array(z.string()).optional().default([]),
  tournament: z.string().max(200).optional().default(''),
  logoTeam1: z.string().nullable().optional(),
  logoTeam2: z.string().nullable().optional(),
  expressLogos: z
    .array(
      z.object({
        logoTeam1: z.string().nullable().optional(),
        logoTeam2: z.string().nullable().optional(),
      })
    )
    .optional().default([]),
}).passthrough();

export const updateBetSchema = createBetSchema.partial();

// ═══════════════════════════════════════════
// Goal schemas
// ═══════════════════════════════════════════

export const createGoalSchema = z.object({
  name: z.string().optional(),
  type: z.enum(['amount', 'ladder', 'roi', 'winrate', 'win_rate']),
  target: z.coerce.number().min(0).optional().default(0),
  current: z.coerce.number().min(0).default(0),
  deadline: z.string().optional(),
  isCompleted: z.boolean().optional(),
  // Extra frontend fields (accepted but not stored in column)
  startAmount: z.coerce.number().optional(),
  targetLadderAmount: z.coerce.number().optional(),
  targetAmount: z.coerce.number().optional(),
  targetROI: z.coerce.number().optional(),
  targetWinRate: z.coerce.number().optional(),
  betsPerDay: z.coerce.number().optional(),
  currentBank: z.coerce.number().optional(),
  currentStep: z.coerce.number().optional(),
  totalSteps: z.coerce.number().optional(),
  minOdds: z.coerce.number().optional(),
  maxOdds: z.coerce.number().optional(),
  avgOdds: z.coerce.number().optional(),
  ladderMode: z.string().optional(),
  isPrimary: z.boolean().optional(),
  status: z.string().optional(),
  steps: z.array(z.unknown()).optional(),
}).passthrough();

export const updateGoalSchema = createGoalSchema.partial();

// ═══════════════════════════════════════════
// Strategy schemas
// ═══════════════════════════════════════════

export const createStrategySchema = z.object({
  name: z.string().min(1).max(200),
  isPrimary: z.boolean().default(false),
  config: z.record(z.unknown()).optional().default({}),
}).passthrough();

export const updateStrategySchema = createStrategySchema.partial().passthrough();

// ═══════════════════════════════════════════
// Bankroll schemas
// ═══════════════════════════════════════════

export const setBankrollSchema = z.object({
  initialBank: z.coerce.number().min(0),
  initialBankUSD: z.coerce.number().min(0).optional(),
  exchangeRate: z.coerce.number().min(0).optional(),
});

export const adjustBankrollSchema = z.object({
  amount: z.coerce.number(),
});

// ═══════════════════════════════════════════
// User update schema
// ═══════════════════════════════════════════

export const updateUserSchema = z.object({
  username: z.string().max(100).optional(),
  password: z.string().max(255).optional(),
  telegram: z.string().max(100).optional(),
  role: z.enum(['admin', 'user']).optional(),
  priceMonth: z.coerce.number().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

// ═══════════════════════════════════════════
// Telegram group + risky team schemas (extracted from routes)
// ═══════════════════════════════════════════

export const telegramGroupSchema = z.object({
  name: z.string().min(1).max(200),
  link: z.string().max(500).default(''),
});

export const riskyTeamSchema = z.object({
  name: z.string().min(1).max(200),
  game: z.string().max(20).optional().default(''),
  status: z.string().max(50).optional().default(''),
  notes: z.string().optional().default(''),
});

// ═══════════════════════════════════════════
// AI schemas
// ═══════════════════════════════════════════

export const aiRecommendSchema = z.object({
  team1: z.string().min(1),
  team2: z.string().min(1),
  format: z.string().default('Bo3'),
  tier: z.string().default('TIER2'),
  odds: z.object({ team1: z.number().optional(), team2: z.number().optional() }).optional(),
});

export const aiAdviceSchema = z.object({
  state: z.enum(['growing', 'stable', 'dipping', 'falling']),
  percentOfPeak: z.number(),
  currentBank: z.number(),
  allTimeHigh: z.number(),
  bets: z.number(),
  profit: z.number(),
});

// ═══════════════════════════════════════════
// Type exports
// ═══════════════════════════════════════════

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type CreateBetInput = z.infer<typeof createBetSchema>;
export type UpdateBetInput = z.infer<typeof updateBetSchema>;
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export type CreateStrategyInput = z.infer<typeof createStrategySchema>;
export type UpdateStrategyInput = z.infer<typeof updateStrategySchema>;
