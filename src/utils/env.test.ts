import { describe, it, expect } from 'vitest';
import { getEnv } from './env';

describe('env validation', () => {
  it('returns cached env config', () => {
    const env = getEnv();
    // Should return a valid config
    expect(typeof env.PORT).toBe('number');
    expect(['development', 'production', 'test']).toContain(env.NODE_ENV);
  });

  it('defaults JWT_EXPIRES_IN to a valid duration string', () => {
    expect(typeof getEnv().JWT_EXPIRES_IN).toBe('string');
    expect(getEnv().JWT_EXPIRES_IN.length).toBeGreaterThan(0);
  });

  it('defaults JWT_REFRESH_EXPIRES_IN to 30d', () => {
    expect(getEnv().JWT_REFRESH_EXPIRES_IN).toBe('30d');
  });

  it('defaults CS_API_URL', () => {
    expect(getEnv().CS_API_URL).toBe('https://api.cstest.pp.ua');
  });

  it('returns the same instance on repeated calls', () => {
    const a = getEnv();
    const b = getEnv();
    expect(a).toBe(b);
  });
});

