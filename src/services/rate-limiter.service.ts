import { AlgorithmFactory } from '../algorithms';
import {
  RateLimitCheckRequest,
  RateLimitCheckResult,
  RateLimitAlgorithm,
} from '../types';
import config from '../config';
import logger from '../utils/logger';
import metricsService from './metrics.service';

/**
 * Main Rate Limiter Service
 * Orchestrates algorithm selection and rate limit checks
 */
class RateLimiterService {
  async check(
    request: RateLimitCheckRequest,
    algorithm: RateLimitAlgorithm = config.defaults.algorithm,
    limit: number = config.defaults.limit,
    windowSeconds: number = config.defaults.windowSeconds
  ): Promise<RateLimitCheckResult> {
    const startTime = Date.now();

    try {
      // Get the appropriate algorithm
      const algo = AlgorithmFactory.getAlgorithm(algorithm);

      // Perform the rate limit check
      const result = await algo.check(request.key, limit, windowSeconds);

      // Record metrics
      const duration = (Date.now() - startTime) / 1000;
      metricsService.recordCheckLatency(algorithm, duration);
      metricsService.recordRequest(algorithm, result.allowed);

      logger.debug('Rate limit check completed', {
        key: request.key,
        algorithm,
        result,
        duration: `${duration * 1000}ms`,
      });

      return result;
    } catch (error) {
      logger.error('Rate limit check failed:', error);
      metricsService.recordRedisError('check');
      throw error;
    }
  }

  async reset(key: string, algorithm: RateLimitAlgorithm): Promise<void> {
    try {
      const algo = AlgorithmFactory.getAlgorithm(algorithm);
      await algo.reset(key);

      logger.info('Rate limit reset', { key, algorithm });
    } catch (error) {
      logger.error('Rate limit reset failed:', error);
      metricsService.recordRedisError('reset');
      throw error;
    }
  }

  async getStats(
    key: string,
    algorithm: RateLimitAlgorithm
  ): Promise<{ count: number; resetAt: number } | null> {
    try {
      const algo = AlgorithmFactory.getAlgorithm(algorithm);
      const stats = await algo.getStats(key);

      logger.debug('Rate limit stats retrieved', { key, algorithm, stats });

      return stats;
    } catch (error) {
      logger.error('Failed to get rate limit stats:', error);
      metricsService.recordRedisError('getStats');
      throw error;
    }
  }
}

export default new RateLimiterService();
