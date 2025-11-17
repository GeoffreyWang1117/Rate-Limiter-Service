import { TokenBucketAlgorithm } from './token-bucket';
import { SlidingWindowAlgorithm } from './sliding-window';
import { FixedWindowAlgorithm } from './fixed-window';
import { IRateLimitAlgorithm, RateLimitAlgorithm } from '../types';

/**
 * Algorithm factory - creates the appropriate rate limiting algorithm
 */
export class AlgorithmFactory {
  private static instances: Map<RateLimitAlgorithm, IRateLimitAlgorithm> = new Map();

  static getAlgorithm(type: RateLimitAlgorithm): IRateLimitAlgorithm {
    // Reuse instances for better performance
    if (!this.instances.has(type)) {
      switch (type) {
        case RateLimitAlgorithm.TOKEN_BUCKET:
          this.instances.set(type, new TokenBucketAlgorithm());
          break;
        case RateLimitAlgorithm.SLIDING_WINDOW:
          this.instances.set(type, new SlidingWindowAlgorithm());
          break;
        case RateLimitAlgorithm.FIXED_WINDOW:
          this.instances.set(type, new FixedWindowAlgorithm());
          break;
        default:
          throw new Error(`Unsupported algorithm: ${type}`);
      }
    }

    return this.instances.get(type)!;
  }

  static clearInstances(): void {
    this.instances.clear();
  }
}

export { TokenBucketAlgorithm, SlidingWindowAlgorithm, FixedWindowAlgorithm };
