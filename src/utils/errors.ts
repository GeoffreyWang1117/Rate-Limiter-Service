/**
 * Custom error classes for Rate Limiter Service
 */

export class RateLimiterError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message);
    this.name = 'RateLimiterError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class RedisConnectionError extends RateLimiterError {
  constructor(message: string) {
    super(message, 503, 'REDIS_CONNECTION_ERROR');
    this.name = 'RedisConnectionError';
  }
}

export class RateLimitExceededError extends RateLimiterError {
  constructor(
    message: string,
    public retryAfter: number
  ) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
    this.name = 'RateLimitExceededError';
  }
}

export class ValidationError extends RateLimiterError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

/**
 * The request was well-formed but conflicts with existing state -- a duplicate
 * name, a uniqueness constraint. Distinct from ValidationError: the caller did
 * not send anything malformed, so 400 would be misleading and 409 tells a client
 * that retrying the identical request will not help.
 */
export class ConflictError extends RateLimiterError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

/** Postgres unique_violation. */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

export class NotFoundError extends RateLimiterError {
  constructor(message: string) {
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}
