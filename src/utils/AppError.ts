/**
 * Application error with HTTP status and operational classification.
 *
 * Operational errors are EXPECTED failures: validation, auth, 404, rate-limit.
 * Programmer errors are UNEXPECTED bugs that indicate a code defect.
 *
 * Usage:
 *   throw new AppError('Not found', 404, 'NOT_FOUND');
 *   throw new AppError('DB connection lost', 500, 'DB_ERROR', false); // programmer
 */

export class AppError extends Error {
  public readonly httpStatus: number;
  public readonly code: string;
  /** true = expected/operational, false = unexpected/programmer bug */
  public readonly isOperational: boolean;

  constructor(
    message: string,
    httpStatus = 500,
    code = 'INTERNAL_ERROR',
    isOperational = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.isOperational = isOperational;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      status: this.httpStatus,
    };
  }
}
