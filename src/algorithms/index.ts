import { TokenBucketAlgorithm } from './token-bucket';
import { SlidingWindowAlgorithm } from './sliding-window';
import { FixedWindowAlgorithm } from './fixed-window';
import { IRateLimitAlgorithm, RateLimitAlgorithm } from '../types';

const registry: Partial<Record<RateLimitAlgorithm, IRateLimitAlgorithm>> = {
  [RateLimitAlgorithm.TOKEN_BUCKET]: new TokenBucketAlgorithm(),
  [RateLimitAlgorithm.SLIDING_WINDOW]: new SlidingWindowAlgorithm(),
  [RateLimitAlgorithm.FIXED_WINDOW]: new FixedWindowAlgorithm(),
};

export class AlgorithmFactory {
  static getAlgorithm(type: RateLimitAlgorithm): IRateLimitAlgorithm {
    const algorithm = registry[type];
    if (!algorithm) {
      throw new Error(`Unsupported algorithm: ${type}`);
    }
    return algorithm;
  }

  static all(): IRateLimitAlgorithm[] {
    return Object.values(registry) as IRateLimitAlgorithm[];
  }

  /**
   * Loads every Lua script into the Redis script cache at boot, so the first
   * request of the process does not pay to ship a script body.
   */
  static async warmAll(): Promise<void> {
    await Promise.all(this.all().map((a) => a.warm()));
  }
}

export { TokenBucketAlgorithm, SlidingWindowAlgorithm, FixedWindowAlgorithm };
