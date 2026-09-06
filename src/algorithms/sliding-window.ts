import { IRateLimitAlgorithm, RateLimitCheckResult } from '../types';
import redisService from '../services/redis.service';
import { SLIDING_WINDOW_SCRIPT } from '../scripts/lua-scripts';
import { RedisScript } from './script-runner';

const script = new RedisScript(SLIDING_WINDOW_SCRIPT, 1, 'sliding_window');

/** Process-local counter; only has to be unique within one millisecond per process. */
let sequence = 0;

/**
 * Sliding window log.
 *
 * Exact: it stores one sorted-set member per admitted request, so there is no
 * boundary burst. Costs `limit` members of memory per key, which is why the
 * fixed window still exists for very large limits.
 *
 * Members used to be UUIDv4 (36 bytes each, plus generation cost on every
 * request). A per-process `${timestamp}-${pid}-${seq}` is unique across
 * replicas for a fraction of the size.
 */
export class SlidingWindowAlgorithm implements IRateLimitAlgorithm {
  private key(key: string): string {
    return `rate_limit:sliding_window:${key}`;
  }

  async check(
    key: string,
    limit: number,
    windowSeconds: number,
    cost = 1
  ): Promise<RateLimitCheckResult> {
    // A sliding-window *log* counts requests, not units of work. Callers that
    // need weighted cost should use the token bucket.
    if (cost !== 1) {
      throw new Error('sliding_window does not support a cost other than 1');
    }
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const member = `${now}-${process.pid}-${sequence++}`;

    const [allowed, count, resetAt, retryAfterMs] = await script.run(
      [this.key(key)],
      [now, windowMs, limit, member]
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

  async reset(key: string): Promise<void> {
    await redisService.getClient().del(this.key(key));
  }

  async getStats(key: string): Promise<{ count: number; resetAt: number } | null> {
    const redis = redisService.getClient();
    const redisKey = this.key(key);
    const [count, pttl] = await Promise.all([redis.zcard(redisKey), redis.pttl(redisKey)]);
    if (count === 0) return null;
    return { count, resetAt: Date.now() + Math.max(0, pttl) };
  }

  async warm(): Promise<void> {
    await script.load();
  }
}
