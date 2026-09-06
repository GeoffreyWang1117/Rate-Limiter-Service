import { IRateLimitAlgorithm, RateLimitCheckResult } from '../types';
import redisService from '../services/redis.service';
import { FIXED_WINDOW_SCRIPT } from '../scripts/lua-scripts';
import { RedisScript } from './script-runner';

const script = new RedisScript(FIXED_WINDOW_SCRIPT, 1, 'fixed_window');

/**
 * Fixed window counter.
 *
 * One integer per key per window. Cheapest of the three, and the only one whose
 * memory does not grow with the limit -- but it permits up to 2x the limit
 * across a window boundary, so it is the wrong choice for a hard quota.
 *
 * reset() and getStats() derive the window key arithmetically. They used to
 * discover keys with `KEYS rate_limit:fixed_window:<key>:*`, which is an O(N)
 * scan of the entire keyspace that blocks the Redis event loop -- on a shard
 * holding the working set of a high-throughput gateway, that is a stall for
 * every other tenant on the shard.
 */
export class FixedWindowAlgorithm implements IRateLimitAlgorithm {
  private windowIndex(now: number, windowSeconds: number): number {
    return Math.floor(now / (windowSeconds * 1000));
  }

  private key(key: string, windowIndex: number): string {
    return `rate_limit:fixed_window:${key}:${windowIndex}`;
  }

  async check(
    key: string,
    limit: number,
    windowSeconds: number,
    cost = 1
  ): Promise<RateLimitCheckResult> {
    if (cost !== 1) {
      throw new Error('fixed_window does not support a cost other than 1');
    }
    const now = Date.now();
    const redisKey = this.key(key, this.windowIndex(now, windowSeconds));

    const [allowed, count, resetAt, retryAfterMs] = await script.run(
      [redisKey],
      [limit, windowSeconds, now]
    );

    return {
      allowed: allowed === 1,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
      ...(allowed === 0 && { retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) }),
      retryAfterMs: allowed === 0 ? retryAfterMs : undefined,
    };
  }

  /**
   * Drops the current and previous window. Those are the only two that can still
   * be consulted: older windows have already expired, and the next one does not
   * exist yet.
   */
  async reset(key: string, windowSeconds = 60): Promise<void> {
    const index = this.windowIndex(Date.now(), windowSeconds);
    await redisService
      .getClient()
      .del(this.key(key, index), this.key(key, index - 1));
  }

  async getStats(
    key: string,
    windowSeconds = 60
  ): Promise<{ count: number; resetAt: number } | null> {
    const now = Date.now();
    const redis = redisService.getClient();
    const redisKey = this.key(key, this.windowIndex(now, windowSeconds));
    const count = await redis.get(redisKey);
    if (count === null) return null;
    const windowMs = windowSeconds * 1000;
    return {
      count: parseInt(count, 10),
      resetAt: (this.windowIndex(now, windowSeconds) + 1) * windowMs,
    };
  }

  async warm(): Promise<void> {
    await script.load();
  }
}
