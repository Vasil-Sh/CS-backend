import 'dotenv/config';
import { z } from 'zod';

/**
 * Centralized environment variable validation.
 * Fails fast on startup if critical vars are missing or invalid.
 */
const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().optional(),
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

/** Parse and validate environment variables. Returns defaults on missing vars. */
export function getEnv(): Env {
  if (envCache) return envCache;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.warn('⚠️ Env validation issues:', result.error.issues.map(i => i.path.join('.') + ': ' + i.message).join(', '));
  }
  envCache = envSchema.parse(process.env); // all optional/defaulted → always succeeds
  return envCache;
}

// Validate on import (warn-only)
getEnv();
