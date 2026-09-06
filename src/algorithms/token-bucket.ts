import { IRateLimitAlgorithm, RateLimitCheckResult } from '../types';
import redisService from '../services/redis.service';
import { TOKEN_BUCKET_SCRIPT } from '../scripts/lua-scripts';
import { RedisScript } from './script-runner';

const script = new RedisScript(TOKEN_BUCKET_SCRIPT, 2, 'token_bucket');

/**
 * Token bucket.
 *
 * Admits bursts up to `limit` and then settles to `limit / windowSeconds` per
 * second. Preferred when clients are bursty but well-behaved on average, which
 * is the normal shape of API traffic.
 *
 * `cost` lets a single call consume more than one token. The LLM admission
 * layer uses that to charge a request its estimated token footprint rather than
 * a flat 1, so a 4k-token prompt cannot slip through the same budget as a 40-token one.
 */
export class TokenBucketAlgorithm implements IRateLimitAlgorithm {
  private keys(key: string): [string, string] {
    return [
      `rate_limit:token_bucket:${key}:tokens`,
      `rate_limit:token_bucket:${key}:timestamp`,
    ];
  }

  async check(
    key: string,
    limit: number,
    windowSeconds: number,
    cost = 1
  ): Promise<RateLimitCheckResult> {
    const refillRate = limit / windowSeconds;
    // Key lifetime must cover a refill from empty to full; expiring sooner would
    // hand an idle client a free full bucket.
    const ttl = Math.ceil(limit / refillRate) + 1;

    const [allowed, remaining, resetAt, retryAfterMs] = await script.run(
      this.keys(key),
      [limit, refillRate, Date.now(), cost, ttl]
    );

    return {
      allowed: allowed === 1,
      limit,
      remaining,
      resetAt,
      ...(allowed === 0 && { retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) }),
      retryAfterMs: allowed === 0 ? retryAfterMs : undefined,
    };
  }

  async reset(key: string): Promise<void> {
    await redisService.getClient().del(...this.keys(key));
  }

  async getStats(key: string): Promise<{ count: number; resetAt: number } | null> {
    const [tokensKey, timestampKey] = this.keys(key);
    const redis = redisService.getClient();
    const [tokens, ttl] = await Promise.all([redis.get(tokensKey), redis.ttl(tokensKey)]);
    if (tokens === null) return null;
    void timestampKey;
    return { count: Math.floor(Number(tokens)), resetAt: Date.now() + Math.max(0, ttl) * 1000 };
  }

  async warm(): Promise<void> {
    await script.load();
  }
}
