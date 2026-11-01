import { describe, it, expect } from 'vitest';
import { recordLoginFailure, loginBlockedMs, clearLoginFailures } from './loginRateLimit';

describe('login rate limit', () => {
  it('blocks one IP + username after 10 failures', () => {
    for (let i = 0; i < 10; i++) recordLoginFailure('1.1.1.1', 'alice');
    expect(loginBlockedMs('1.1.1.1', 'alice')).toBeGreaterThan(0);
    expect(loginBlockedMs('2.2.2.2', 'alice')).toBe(0);
    clearLoginFailures('1.1.1.1', 'alice');
  });

  it('blocks the account after 30 failures even when every attempt uses a different IP', () => {
    for (let i = 0; i < 30; i++) recordLoginFailure(`10.0.0.${i}`, 'Owner');
    expect(loginBlockedMs('99.99.99.99', 'owner')).toBeGreaterThan(0);
    expect(loginBlockedMs('99.99.99.99', 'someone-else')).toBe(0);
  });
});
