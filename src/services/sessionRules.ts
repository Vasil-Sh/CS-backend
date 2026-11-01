import { isSubscriptionExpired, kyivToday } from '../utils/kyivDate';

/** Current account state from the DB (not from the token). */
export interface UserState {
  role: string;
  tokenVersion: number;
  startDate: string | null;
  endDate: string | null;
}

export type SessionProblem = 'deleted' | 'revoked' | 'expired' | 'not_started';

/**
 * Why a still-valid JWT must no longer be accepted, or null if it is fine.
 * Lets admin actions take effect immediately instead of when the token expires:
 * deleted account, password reset (token version bumped), subscription ended
 * or not yet started. Admins have no subscription limits.
 */
export function sessionProblem(tokenVersion: number | undefined, state: UserState | null, now: Date = new Date()): SessionProblem | null {
  if (!state) return 'deleted';
  if ((tokenVersion ?? 0) !== state.tokenVersion) return 'revoked';
  if (state.role !== 'admin') {
    if (isSubscriptionExpired(state.endDate, now)) return 'expired';
    if (state.startDate && String(state.startDate).slice(0, 10) > kyivToday(now)) return 'not_started';
  }
  return null;
}

export const sessionProblemMessage: Record<SessionProblem, string> = {
  deleted: 'Обліковий запис не знайдено',
  revoked: 'Сесію завершено. Увійдіть знову',
  expired: 'Термін підписки закінчився. Зверніться до адміністратора, щоб продовжити',
  not_started: 'Підписка ще не почалася',
};
