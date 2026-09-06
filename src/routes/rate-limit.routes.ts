import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import rateLimiterService from '../services/rate-limiter.service';
import { validateRequest } from '../middleware/validate-request';
import { guardState } from '../middleware/degraded-mode';
import { RateLimitAlgorithm } from '../types';

const router = Router();

/**
 * When Redis is unreachable this surface falls back to the configured mode.
 * Fail-open reports the request as allowed with the caller's own limit echoed
 * back, and flags the response as degraded so nothing downstream mistakes it
 * for an enforced verdict.
 */
const guarded = guardState('rateLimit', (req) => ({
  allowed: true,
  limit: req.body?.limit ?? null,
  remaining: null,
  resetAt: null,
}));

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
  // Fixed-window keys are indexed by window, so the caller has to say which
  // window size it configured or the wrong key gets cleared.
  windowSeconds: Joi.number().integer().min(1).max(86400).optional(),
});

const getStatsSchema = Joi.object({
  key: Joi.string().required().min(1).max(256),
  algorithm: Joi.string()
    .valid(...Object.values(RateLimitAlgorithm))
    .required(),
  windowSeconds: Joi.number().integer().min(1).max(86400).optional(),
});

/**
 * POST /api/v1/check-rate-limit
 * Check if a request should be rate limited
 */
router.post(
  '/check-rate-limit',
  validateRequest(checkRateLimitSchema),
  guarded(async (req: Request, res: Response) => {
      const { key, identifier, algorithm, limit, windowSeconds, endpoint, metadata } =
        req.body;

      const result = await rateLimiterService.check(
        { key, identifier, endpoint, ip: req.ip, metadata },
        { algorithm, limit, windowSeconds }
      );

      res.set({
        'X-RateLimit-Limit': result.limit.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': new Date(result.resetAt).toISOString(),
        // Which rule produced this verdict. Without it, a 429 in production is
        // untraceable to the configuration that caused it.
        'X-RateLimit-Policy': result.effective.ruleName ?? result.effective.source,
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
        effective: result.effective,
      });
  })
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
      const { key, algorithm, windowSeconds } = req.body;

      await rateLimiterService.reset(key, algorithm, windowSeconds);

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
      const { key, algorithm, windowSeconds } = req.body;

      const stats = await rateLimiterService.getStats(key, algorithm, windowSeconds);

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
