import { IRateLimitAlgorithm, RateLimitCheckResult } from '../types';
import redisService from '../services/redis.service';
import { FIXED_WINDOW_SCRIPT } from '../scripts/lua-scripts';
import logger from '../utils/logger';

/**
 * Fixed Window Counter Algorithm Implementation
 *
 * Best for: Simple, efficient rate limiting
 * Characteristics:
 * - Very low memory usage (single counter per window)
 * - Simple and fast
 * - Potential burst at window boundaries
 * - Good for most use cases
 */
export class FixedWindowAlgorithm implements IRateLimitAlgorithm {
  private scriptSha: string | null = null;

  constructor() {
    this.initializeScript();
  }

  private async initializeScript(): Promise<void> {
    try {
      const redis = redisService.getClient();
      this.scriptSha = await redis.script('LOAD', FIXED_WINDOW_SCRIPT);
      logger.info('Fixed Window Lua script loaded', { sha: this.scriptSha });
    } catch (error) {
      logger.error('Failed to load Fixed Window Lua script:', error);
    }
  }

  async check(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<RateLimitCheckResult> {
    const redis = redisService.getClient();
    const now = Date.now();

    // Create window-aligned key
    const currentWindow = Math.floor(now / (windowSeconds * 1000));
    const redisKey = `rate_limit:fixed_window:${key}:${currentWindow}`;

    try {
      let result: number[];

      if (this.scriptSha) {
        try {
          result = (await redis.evalsha(
            this.scriptSha,
            1,
            redisKey,
            limit.toString(),
            windowSeconds.toString(),
            now.toString()
          )) as number[];
        } catch (error) {
          logger.warn('Script SHA not found, reloading...');
          this.scriptSha = null;
          result = await this.executeScript(
            redis,
            redisKey,
            limit,
            windowSeconds,
            now
          );
        }
      } else {
        result = await this.executeScript(redis, redisKey, limit, windowSeconds, now);
      }

      const allowed = result[0] === 1;
      const currentCount = Math.floor(result[1]);
      const resetAt = Math.floor(result[2]);
      const retryAfter = result[3] ? Math.floor(result[3]) : undefined;

      logger.debug('Fixed Window check result', {
        key,
        allowed,
        currentCount,
        remaining: limit - currentCount,
        resetAt,
        retryAfter,
      });

      return {
        allowed,
        limit,
        remaining: Math.max(0, limit - currentCount),
        resetAt,
        retryAfter,
      };
    } catch (error) {
      logger.error('Fixed Window check failed:', error);
      throw error;
    }
  }

  private async executeScript(
    redis: any,
    redisKey: string,
    limit: number,
    windowSeconds: number,
    now: number
  ): Promise<number[]> {
    const result = (await redis.eval(
      FIXED_WINDOW_SCRIPT,
      1,
      redisKey,
      limit.toString(),
      windowSeconds.toString(),
      now.toString()
    )) as number[];

    if (!this.scriptSha) {
      this.scriptSha = await redis.script('LOAD', FIXED_WINDOW_SCRIPT);
    }

    return result;
  }

  async reset(key: string): Promise<void> {
    const redis = redisService.getClient();
    const pattern = `rate_limit:fixed_window:${key}:*`;

    // Find all window keys for this identifier
    const keys = await redis.keys(pattern);

    if (keys.length > 0) {
      await redis.del(...keys);
    }

    logger.info('Fixed Window reset', { key, keysDeleted: keys.length });
  }

  async getStats(key: string): Promise<{ count: number; resetAt: number } | null> {
    const redis = redisService.getClient();
    const now = Date.now();

    // Find the current window key
    const pattern = `rate_limit:fixed_window:${key}:*`;
    const keys = await redis.keys(pattern);

    if (keys.length === 0) {
      return null;
    }

    // Get the most recent window
    const sortedKeys = keys.sort().reverse();
    const currentKey = sortedKeys[0];

    try {
      const [count, ttl] = await Promise.all([
        redis.get(currentKey),
        redis.ttl(currentKey),
      ]);

      if (!count) {
        return null;
      }

      const resetAt = now + ttl * 1000;

      return {
        count: parseInt(count, 10),
        resetAt,
      };
    } catch (error) {
      logger.error('Failed to get Fixed Window stats:', error);
      return null;
    }
  }
}
