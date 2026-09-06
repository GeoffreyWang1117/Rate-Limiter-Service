import type { Redis } from 'ioredis';
import { createHash } from 'crypto';
import redisService from '../services/redis.service';
import metricsService from '../services/metrics.service';

/**
 * A Lua script that is executed by SHA and only shipped in full when the server
 * says it does not have it.
 *
 * The original implementation loaded the script from the constructor with an
 * un-awaited async call, so the first few requests after boot raced the load and
 * fell back to sending the whole script body. It also caught *every* EVALSHA
 * error and retried with EVAL, which turns a genuine Lua error into two round
 * trips and hides it behind a warning.
 *
 * Here the SHA is computed locally (it is just sha1 of the body, no round trip
 * needed), and only a NOSCRIPT reply -- the server restarted or SCRIPT FLUSH ran
 * -- triggers a reload. Anything else propagates.
 */
export class RedisScript {
  private readonly sha: string;

  constructor(
    private readonly body: string,
    private readonly numKeys: number,
    private readonly name: string
  ) {
    this.sha = createHash('sha1').update(body).digest('hex');
  }

  async run<T = number[]>(keys: string[], args: (string | number)[]): Promise<T> {
    if (keys.length !== this.numKeys) {
      throw new Error(
        `${this.name}: expected ${this.numKeys} keys, received ${keys.length}`
      );
    }
    const redis: Redis = redisService.getClient();
    const started = process.hrtime.bigint();
    try {
      return (await this.evalWithReload(redis, keys, args)) as T;
    } finally {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      metricsService.recordRedisLatency(this.name, seconds);
    }
  }

  private async evalWithReload(
    redis: Redis,
    keys: string[],
    args: (string | number)[]
  ): Promise<unknown> {
    try {
      return await redis.evalsha(this.sha, this.numKeys, ...keys, ...args);
    } catch (error) {
      if (!isNoScriptError(error)) throw error;
      // Redis lost its script cache. Ship the body once; it is cached again under
      // the same SHA, so subsequent calls go back to EVALSHA.
      return await redis.eval(this.body, this.numKeys, ...keys, ...args);
    }
  }

  /** Pre-warms the server-side script cache. Safe to call repeatedly. */
  async load(): Promise<void> {
    const redis: Redis = redisService.getClient();
    await redis.script('LOAD', this.body);
  }
}

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOSCRIPT');
}
