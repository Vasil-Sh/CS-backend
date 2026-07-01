import { describe, it, expect } from 'vitest';
import {
  loginSchema,
  registerSchema,
  createBetSchema,
  updateBetSchema,
  createGoalSchema,
  updateGoalSchema,
  createStrategySchema,
  updateStrategySchema,
  setBankrollSchema,
  adjustBankrollSchema,
} from './validation';

describe('loginSchema', () => {
  it('accepts valid login input', () => {
    const result = loginSchema.safeParse({ username: 'john', password: 'secret123' });
    expect(result.success).toBe(true);
  });

  it('rejects empty username', () => {
    const result = loginSchema.safeParse({ username: '', password: 'secret' });
    expect(result.success).toBe(false);
  });

  it('rejects empty password', () => {
    const result = loginSchema.safeParse({ username: 'john', password: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(loginSchema.safeParse({}).success).toBe(false);
    expect(loginSchema.safeParse({ username: 'john' }).success).toBe(false);
    expect(loginSchema.safeParse({ password: 'secret' }).success).toBe(false);
  });
});

describe('createBetSchema', () => {
  it('accepts minimal valid bet', () => {
    const result = createBetSchema.safeParse({
      match: 'NAVI vs FaZe',
      odds: 1.85,
      amount: 100,
      betType: 'Ординар',
    });
    expect(result.success).toBe(true);
  });

  it('coerces string numbers', () => {
    const result = createBetSchema.safeParse({
      match: 'NAVI vs FaZe',
      odds: '1.85',
      amount: '100',
      betType: 'Ординар',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.odds).toBe(1.85);
      expect(result.data.amount).toBe(100);
    }
  });

  it('rejects negative odds', () => {
    const result = createBetSchema.safeParse({
      match: 'Test',
      odds: -1,
      amount: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects odds over 1000', () => {
    const result = createBetSchema.safeParse({
      match: 'Test',
      odds: 1001,
      amount: 100,
    });
    expect(result.success).toBe(false);
  });

  it('accepts express bet with expressLogos', () => {
    const result = createBetSchema.safeParse({
      match: 'Express #1',
      odds: 3.5,
      amount: 50,
      betType: 'Експрес',
      expressLogos: [
        { logoTeam1: 'https://img.com/a.png', logoTeam2: 'https://img.com/b.png' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts all optional fields', () => {
    const result = createBetSchema.safeParse({
      match: 'Full Match',
      odds: 2.0,
      amount: 200,
      team1: 'NAVI',
      team2: 'G2',
      betType: 'Ординар',
      stake: 50,
      date: '2026-07-01',
      result: 'Pending',
      profit: 100,
      strategy: 'Safe play',
      format: 'Bo3',
      game: 'CS2',
      currency: 'USD',
      notes: 'Test bet',
      tournament: 'IEM Cologne',
      riskyTeams: ['Team A'],
    });
    expect(result.success).toBe(true);
  });
});

describe('updateBetSchema', () => {
  it('accepts partial updates', () => {
    const result = updateBetSchema.safeParse({ result: 'Win', profit: 85 });
    expect(result.success).toBe(true);
  });

  it('accepts empty object', () => {
    const result = updateBetSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('createGoalSchema', () => {
  it('accepts valid goal', () => {
    const result = createGoalSchema.safeParse({
      type: 'amount',
      target: 1000,
      current: 500,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid goal type', () => {
    const result = createGoalSchema.safeParse({
      type: 'invalid_type',
      target: 100,
    });
    expect(result.success).toBe(false);
  });

  it('accepts winrate as valid type', () => {
    const result = createGoalSchema.safeParse({ type: 'winrate', target: 60 });
    expect(result.success).toBe(true);
  });

  it('accepts all goal types', () => {
    for (const type of ['amount', 'ladder', 'roi', 'winrate', 'win_rate']) {
      const result = createGoalSchema.safeParse({ type, target: 100 });
      expect(result.success).toBe(true);
    }
  });
});

describe('createStrategySchema', () => {
  it('accepts valid strategy', () => {
    const result = createStrategySchema.safeParse({
      name: 'My Strategy',
      config: { rules: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = createStrategySchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });
});

describe('bankroll schemas', () => {
  it('setBankrollSchema accepts positive numbers', () => {
    expect(setBankrollSchema.safeParse({ initialBank: 1000 }).success).toBe(true);
    expect(setBankrollSchema.safeParse({ initialBank: 0 }).success).toBe(true);
    expect(setBankrollSchema.safeParse({ initialBank: -100 }).success).toBe(false);
  });

  it('adjustBankrollSchema accepts any number', () => {
    expect(adjustBankrollSchema.safeParse({ amount: 500 }).success).toBe(true);
    expect(adjustBankrollSchema.safeParse({ amount: -200 }).success).toBe(true);
    expect(adjustBankrollSchema.safeParse({ amount: 0 }).success).toBe(true);
  });
});
