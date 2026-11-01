import { describe, it, expect } from 'vitest';
import { isAllowedOrigin } from './allowedOrigins';

const prod = { NODE_ENV: 'production', CORS_ORIGINS: 'https://matchiq.pro, https://admin.example.com/' } as NodeJS.ProcessEnv;
const dev = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

describe('isAllowedOrigin', () => {
  it('allows exactly the configured production origins', () => {
    expect(isAllowedOrigin('https://matchiq.pro', prod)).toBe(true);
    expect(isAllowedOrigin('https://admin.example.com', prod)).toBe(true);
  });

  it('rejects look-alike domains that only share a prefix', () => {
    expect(isAllowedOrigin('https://matchiq.pro.evil.com', prod)).toBe(false);
    expect(isAllowedOrigin('https://evil.vercel.app', prod)).toBe(false);
    expect(isAllowedOrigin('http://localhost:5174', prod)).toBe(false);
  });

  it('falls back to matchiq.pro when CORS_ORIGINS is unset', () => {
    const env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(isAllowedOrigin('https://www.matchiq.pro', env)).toBe(true);
  });

  it('allows localhost and Vercel previews in development', () => {
    expect(isAllowedOrigin('http://localhost:5174', dev)).toBe(true);
    expect(isAllowedOrigin('https://matchiq-git-feature.vercel.app', dev)).toBe(true);
    expect(isAllowedOrigin('http://localhost.evil.com', dev)).toBe(false);
  });
});
