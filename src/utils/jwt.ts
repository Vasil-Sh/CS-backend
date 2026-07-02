import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const SECRET = process.env.JWT_SECRET || (() => { throw new Error('JWT_SECRET must be set'); })();
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || crypto.randomBytes(32).toString('hex');
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

if (!process.env.JWT_REFRESH_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.warn('⚠️ JWT_REFRESH_SECRET not set — auto-generated. Refresh tokens invalidated on restart.');
  } else {
    console.warn('⚠️ JWT_REFRESH_SECRET not set — set it in .env for persistence.');
  }
}

export interface JwtPayload {
  userId: number;
  username: string;
  role: 'admin' | 'user';
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload as object, SECRET, { expiresIn: EXPIRES_IN } as jwt.SignOptions);
}

export function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, type: 'refresh' } as object, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, SECRET) as JwtPayload & { type?: string };
  // Access tokens must NOT have type='refresh'
  if (decoded.type === 'refresh') throw new Error('Invalid token type');
  return decoded;
}

export function verifyRefreshToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, REFRESH_SECRET) as JwtPayload & { type?: string };
  if (decoded.type !== 'refresh') throw new Error('Invalid refresh token');
  return decoded;
}
