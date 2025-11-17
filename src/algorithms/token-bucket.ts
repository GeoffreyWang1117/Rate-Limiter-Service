import { IRateLimitAlgorithm, RateLimitCheckResult } from '../types';
import redisService from '../services/redis.service';
import { TOKEN_BUCKET_SCRIPT } from '../scripts/lua-scripts';
import logger from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

/**
 * Token Bucket Algorithm Implementation
 *
 * Best for: Allowing bursts while maintaining average rate
 * Characteristics:
 * - Tokens are added at a constant rate
 * - Each request consumes one token
 * - Allows burst traffic up to bucket capacity
 * - Smooth rate limiting over time
 */
export class TokenBucketAlgorithm implements IRateLimitAlgorithm {
  private scriptSha: string | null = null;

  constructor() {
    this.initializeScript();
  }

  private async initializeScript(): Promise<void> {
    try {
      const redis = redisService.getClient();
      this.scriptSha = await redis.script('LOAD', TOKEN_BUCKET_SCRIPT);
      logger.info('Token Bucket Lua script loaded', { sha: this.scriptSha });
    } catch (error) {
      logger.error('Failed to load Token Bucket Lua script:', error);
    }
  }

  async check(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<RateLimitCheckResult> {
    const redis = redisService.getClient();
    const now = Date.now();

    const tokensKey = `rate_limit:token_bucket:${key}:tokens`;
    const timestampKey = `rate_limit:token_bucket:${key}:timestamp`;

    // Refill rate: tokens per second
    const refillRate = limit / windowSeconds;

    try {
      // Try to use cached script first
      let result: number[];

      if (this.scriptSha) {
        try {
          result = (await redis.evalsha(
            this.scriptSha,
            2,
            tokensKey,
            timestampKey,
            limit.toString(),
            refillRate.toString(),
            now.toString(),
            '1', // tokens requested
            windowSeconds.toString()
          )) as number[];
        } catch (error) {
          // Script not found, reload it
          logger.warn('Script SHA not found, reloading...');
          this.scriptSha = null;
          result = await this.executeScript(
            redis,
            tokensKey,
            timestampKey,
            limit,
            refillRate,
            now,
            windowSeconds
          );
        }
      } else {
        result = await this.executeScript(
          redis,
          tokensKey,
          timestampKey,
          limit,
          refillRate,
          now,
          windowSeconds
        );
      }

      const allowed = result[0] === 1;
      const remaining = Math.floor(result[1]);
      const resetAt = Math.floor(result[2]);
      const retryAfter = result[3] ? Math.floor(result[3]) : undefined;

      logger.debug('Token Bucket check result', {
        key,
        allowed,
        remaining,
        resetAt,
        retryAfter,
      });

      return {
        allowed,
        limit,
        remaining,
        resetAt,
        retryAfter,
      };
    } catch (error) {
      logger.error('Token Bucket check failed:', error);
      throw error;
    }
  }

  private async executeScript(
    redis: any,
    tokensKey: string,
    timestampKey: string,
    limit: number,
    refillRate: number,
    now: number,
    windowSeconds: number
  ): Promise<number[]> {
    const result = (await redis.eval(
      TOKEN_BUCKET_SCRIPT,
      2,
      tokensKey,
      timestampKey,
      limit.toString(),
      refillRate.toString(),
      now.toString(),
      '1',
      windowSeconds.toString()
    )) as number[];

    // Cache the script SHA for future use
    if (!this.scriptSha) {
      this.scriptSha = await redis.script('LOAD', TOKEN_BUCKET_SCRIPT);
    }

    return result;
  }

  async reset(key: string): Promise<void> {
    const redis = redisService.getClient();
    const tokensKey = `rate_limit:token_bucket:${key}:tokens`;
    const timestampKey = `rate_limit:token_bucket:${key}:timestamp`;

    await redis.del(tokensKey, timestampKey);
    logger.info('Token Bucket reset', { key });
  }

  async getStats(key: string): Promise<{ count: number; resetAt: number } | null> {
    const redis = redisService.getClient();
    const tokensKey = `rate_limit:token_bucket:${key}:tokens`;
    const timestampKey = `rate_limit:token_bucket:${key}:timestamp`;

    try {
      const [tokens, timestamp, ttl] = await Promise.all([
        redis.get(tokensKey),
        redis.get(timestampKey),
        redis.ttl(tokensKey),
      ]);

      if (!tokens || !timestamp) {
        return null;
      }

      const now = Date.now();
      const resetAt = now + ttl * 1000;

      return {
        count: parseInt(tokens, 10),
        resetAt,
      };
    } catch (error) {
      logger.error('Failed to get Token Bucket stats:', error);
      return null;
    }
  }
}
