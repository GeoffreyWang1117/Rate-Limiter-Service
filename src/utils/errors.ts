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

export class NotFoundError extends RateLimiterError {
  constructor(message: string) {
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}
