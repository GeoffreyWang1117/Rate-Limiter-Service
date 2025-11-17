import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import rateLimiterService from '../services/rate-limiter.service';
import { validateRequest } from '../middleware/validate-request';
import { RateLimitAlgorithm } from '../types';
import logger from '../utils/logger';

const router = Router();

// Validation schemas
const checkRateLimitSchema = Joi.object({
  key: Joi.string().required().min(1).max(256),
  identifier: Joi.string().required().min(1).max(256),
  algorithm: Joi.string()
    .valid(...Object.values(RateLimitAlgorithm))
    .optional(),
  limit: Joi.number().integer().min(1).max(1000000).optional(),
  windowSeconds: Joi.number().integer().min(1).max(86400).optional(),
  endpoint: Joi.string().optional(),
  metadata: Joi.object().optional(),
});

const resetRateLimitSchema = Joi.object({
  key: Joi.string().required().min(1).max(256),
  algorithm: Joi.string()
    .valid(...Object.values(RateLimitAlgorithm))
    .required(),
});

const getStatsSchema = Joi.object({
  key: Joi.string().required().min(1).max(256),
  algorithm: Joi.string()
    .valid(...Object.values(RateLimitAlgorithm))
    .required(),
});

/**
 * POST /api/v1/check-rate-limit
 * Check if a request should be rate limited
 */
router.post(
  '/check-rate-limit',
  validateRequest(checkRateLimitSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key, identifier, algorithm, limit, windowSeconds, endpoint, metadata } =
        req.body;

      const result = await rateLimiterService.check(
        { key, identifier, endpoint, metadata },
        algorithm,
        limit,
        windowSeconds
      );

      // Set standard rate limit headers
      res.set({
        'X-RateLimit-Limit': result.limit.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': new Date(result.resetAt).toISOString(),
      });

      if (!result.allowed && result.retryAfter) {
        res.set('Retry-After', result.retryAfter.toString());
      }

      res.status(result.allowed ? 200 : 429).json({
        allowed: result.allowed,
        limit: result.limit,
        remaining: result.remaining,
        resetAt: result.resetAt,
        ...(result.retryAfter && { retryAfter: result.retryAfter }),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/reset
 * Reset rate limit for a specific key
 */
router.post(
  '/reset',
  validateRequest(resetRateLimitSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key, algorithm } = req.body;

      await rateLimiterService.reset(key, algorithm);

      res.status(200).json({
        success: true,
        message: `Rate limit reset for key: ${key}`,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/stats
 * Get current stats for a rate limit key
 */
router.post(
  '/stats',
  validateRequest(getStatsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key, algorithm } = req.body;

      const stats = await rateLimiterService.getStats(key, algorithm);

      if (!stats) {
        res.status(404).json({
          error: 'No stats found for this key',
        });
        return;
      }

      res.status(200).json({
        key,
        algorithm,
        currentCount: stats.count,
        resetAt: stats.resetAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
