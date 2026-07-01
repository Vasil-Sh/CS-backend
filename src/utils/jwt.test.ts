import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { signToken, verifyToken, signRefreshToken, verifyRefreshToken } from './jwt';
import type { JwtPayload } from './jwt';

const TEST_PAYLOAD: JwtPayload = {
  userId: 1,
  username: 'testuser',
  role: 'user',
};

describe('JWT utils', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    process.env.JWT_EXPIRES_IN = '1h';
    process.env.JWT_REFRESH_EXPIRES_IN = '7d';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('signToken', () => {
    it('creates a valid JWT string', () => {
      const token = signToken(TEST_PAYLOAD);
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('encodes different payloads into different tokens', () => {
      const token1 = signToken(TEST_PAYLOAD);
      const token2 = signToken({ userId: 2, username: 'other', role: 'admin' });
      expect(token1).not.toBe(token2);
    });
  });

  describe('verifyToken', () => {
    it('decodes a valid token back to the original payload', () => {
      const token = signToken(TEST_PAYLOAD);
      const decoded = verifyToken(token);
      expect(decoded.userId).toBe(TEST_PAYLOAD.userId);
      expect(decoded.username).toBe(TEST_PAYLOAD.username);
      expect(decoded.role).toBe(TEST_PAYLOAD.role);
    });

    it('throws on invalid token', () => {
      expect(() => verifyToken('invalid.token.here')).toThrow();
    });

    it('produces different tokens with different payloads', () => {
      const token1 = signToken(TEST_PAYLOAD);
      const decoded = verifyToken(token1);
      expect(decoded.userId).toBe(TEST_PAYLOAD.userId);
      expect(decoded.username).toBe(TEST_PAYLOAD.username);
    });
  });

  describe('signRefreshToken / verifyRefreshToken', () => {
    it('creates and verifies refresh tokens', () => {
      const token = signRefreshToken(TEST_PAYLOAD);
      expect(typeof token).toBe('string');

      const decoded = verifyRefreshToken(token);
      expect(decoded.userId).toBe(TEST_PAYLOAD.userId);
      expect(decoded.username).toBe(TEST_PAYLOAD.username);
    });

    it('refresh token cannot be verified as access token', () => {
      const refreshToken = signRefreshToken(TEST_PAYLOAD);
      expect(() => verifyToken(refreshToken)).toThrow();
    });

    it('access token cannot be verified as refresh token', () => {
      const accessToken = signToken(TEST_PAYLOAD);
      expect(() => verifyRefreshToken(accessToken)).toThrow();
    });
  });
});
