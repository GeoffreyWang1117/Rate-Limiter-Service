import { Request, Response, NextFunction } from 'express';
import { RateLimiterError } from '../utils/errors';
import logger from '../utils/logger';
import metricsService from '../services/metrics.service';

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  logger.error('Error occurred:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  if (err instanceof RateLimiterError) {
    metricsService.recordApiRequest(req.method, req.path, err.statusCode);

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.name === 'RateLimitExceededError' && {
          retryAfter: (err as any).retryAfter,
        }),
      },
    });
    return;
  }

  // Generic error
  metricsService.recordApiRequest(req.method, req.path, 500);
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  });
};
