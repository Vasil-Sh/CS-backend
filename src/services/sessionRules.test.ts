import { describe, it, expect } from 'vitest';
import { sessionProblem } from './sessionRules';

const now = new Date('2026-11-01T10:00:00Z'); // 12:00 Kyiv
const user = { role: 'user', tokenVersion: 0, startDate: '2026-10-01', endDate: '2026-11-30' };

describe('sessionProblem', () => {
  it('accepts an active user and tokens issued before token versions existed', () => {
    expect(sessionProblem(0, user, now)).toBeNull();
    expect(sessionProblem(undefined, user, now)).toBeNull();
  });
  it('rejects deleted accounts', () => {
    expect(sessionProblem(0, null, now)).toBe('deleted');
  });
  it('rejects tokens issued before a password reset', () => {
    expect(sessionProblem(0, { ...user, tokenVersion: 1 }, now)).toBe('revoked');
    expect(sessionProblem(1, { ...user, tokenVersion: 1 }, now)).toBeNull();
  });
  it('ends the session when the subscription ends (last day still allowed)', () => {
    expect(sessionProblem(0, { ...user, endDate: '2026-11-01' }, now)).toBeNull();
    expect(sessionProblem(0, { ...user, endDate: '2026-10-31' }, now)).toBe('expired');
  });
  it('blocks a subscription that starts in the future', () => {
    expect(sessionProblem(0, { ...user, startDate: '2026-11-02' }, now)).toBe('not_started');
  });
  it('never limits admins by subscription dates', () => {
    expect(sessionProblem(0, { ...user, role: 'admin', endDate: '2020-01-01', startDate: '2030-01-01' }, now)).toBeNull();
  });
});
