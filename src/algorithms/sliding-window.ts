import { IRateLimitAlgorithm, RateLimitCheckResult } from '../types';
import redisService from '../services/redis.service';
import { SLIDING_WINDOW_SCRIPT } from '../scripts/lua-scripts';
import logger from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

/**
 * Sliding Window Counter Algorithm Implementation
 *
 * Best for: Precise rate limiting with smooth distribution
 * Characteristics:
 * - Uses sorted set to track individual requests
 * - More accurate than fixed window
 * - No boundary issues
 * - Higher memory usage (stores each request)
 */
export class SlidingWindowAlgorithm implements IRateLimitAlgorithm {
  private scriptSha: string | null = null;

  constructor() {
    this.initializeScript();
  }

  private async initializeScript(): Promise<void> {
    try {
      const redis = redisService.getClient();
      this.scriptSha = await redis.script('LOAD', SLIDING_WINDOW_SCRIPT);
      logger.info('Sliding Window Lua script loaded', { sha: this.scriptSha });
    } catch (error) {
      logger.error('Failed to load Sliding Window Lua script:', error);
    }
  }

  async check(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<RateLimitCheckResult> {
    const redis = redisService.getClient();
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const redisKey = `rate_limit:sliding_window:${key}`;
    const requestId = uuidv4();

    try {
      let result: number[];

      if (this.scriptSha) {
        try {
          result = (await redis.evalsha(
            this.scriptSha,
            1,
            redisKey,
            now.toString(),
            windowMs.toString(),
            limit.toString(),
            requestId,
            windowSeconds.toString()
          )) as number[];
        } catch (error) {
          logger.warn('Script SHA not found, reloading...');
          this.scriptSha = null;
          result = await this.executeScript(
            redis,
            redisKey,
            now,
            windowMs,
            limit,
            requestId,
            windowSeconds
          );
        }
      } else {
        result = await this.executeScript(
          redis,
          redisKey,
          now,
          windowMs,
          limit,
          requestId,
          windowSeconds
        );
      }

      const allowed = result[0] === 1;
      const currentCount = Math.floor(result[1]);
      const resetAt = Math.floor(result[2]);
      const retryAfter = result[3] ? Math.floor(result[3]) : undefined;

      logger.debug('Sliding Window check result', {
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
      logger.error('Sliding Window check failed:', error);
      throw error;
    }
  }

  private async executeScript(
    redis: any,
    redisKey: string,
    now: number,
    windowMs: number,
    limit: number,
    requestId: string,
    windowSeconds: number
  ): Promise<number[]> {
    const result = (await redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      redisKey,
      now.toString(),
      windowMs.toString(),
      limit.toString(),
      requestId,
      windowSeconds.toString()
    )) as number[];

    if (!this.scriptSha) {
      this.scriptSha = await redis.script('LOAD', SLIDING_WINDOW_SCRIPT);
    }

    return result;
  }

  async reset(key: string): Promise<void> {
    const redis = redisService.getClient();
    const redisKey = `rate_limit:sliding_window:${key}`;

    await redis.del(redisKey);
    logger.info('Sliding Window reset', { key });
  }

  async getStats(key: string): Promise<{ count: number; resetAt: number } | null> {
    const redis = redisService.getClient();
    const redisKey = `rate_limit:sliding_window:${key}`;

    try {
      const now = Date.now();
      const count = await redis.zcard(redisKey);

      if (count === 0) {
        return null;
      }

      // Get the oldest entry to determine reset time
      const oldest = await redis.zrange(redisKey, 0, 0, 'WITHSCORES');
      const ttl = await redis.ttl(redisKey);

      const resetAt = now + ttl * 1000;

      return {
        count,
        resetAt,
      };
    } catch (error) {
      logger.error('Failed to get Sliding Window stats:', error);
      return null;
    }
  }
}
