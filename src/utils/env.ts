import 'dotenv/config';
import { z } from 'zod';

/**
 * Centralized environment variable validation.
 * Fails fast on startup if critical vars are missing or invalid.
 */
const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL URL'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  DEEPSEEK_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  CS_API_URL: z.string().default('https://api.cstest.pp.ua'),
  GOOGLE_SHEETS_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let envCache: Env | null = null;

/** Parse and validate environment variables. Caches result. */
export function getEnv(): Env {
  if (envCache) return envCache;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    for (const issue of result.error.issues) {
      console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  envCache = result.data;
  return envCache;
}

// Validate on import (fail-fast)
getEnv();
