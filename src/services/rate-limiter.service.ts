import { AlgorithmFactory } from '../algorithms';
import {
  RateLimitCheckRequest,
  RateLimitCheckResult,
  RateLimitAlgorithm,
} from '../types';
import config from '../config';
import logger from '../utils/logger';
import metricsService from './metrics.service';
import ruleEngineService from './rule-engine.service';

export interface EffectiveLimit {
  algorithm: RateLimitAlgorithm;
  limit: number;
  windowSeconds: number;
  /** Where the numbers came from, so a 429 can be traced to a specific rule. */
  source: 'request' | 'rule' | 'default';
  ruleId?: string;
  ruleName?: string;
}

export interface RateLimitDecision extends RateLimitCheckResult {
  effective: EffectiveLimit;
}

export interface CheckOverrides {
  algorithm?: RateLimitAlgorithm;
  limit?: number;
  windowSeconds?: number;
}

class RateLimiterService {
  /**
   * Resolves which limit applies, then applies it.
   *
   * Precedence is explicit request parameters, then the highest-priority
   * matching stored rule, then the service defaults. Stored rules were
   * previously unreachable: the rule engine was written, persisted and exposed
   * over CRUD, but nothing on the decision path ever called it, so every
   * configured rule was inert and the service silently used defaults.
   */
  async resolveLimit(
    request: RateLimitCheckRequest,
    overrides: CheckOverrides = {}
  ): Promise<EffectiveLimit> {
    // A caller that states its own limit is trusted over stored config: that is
    // how a service embeds its own known-correct limit without a round trip to
    // an operator.
    if (
      overrides.algorithm !== undefined &&
      overrides.limit !== undefined &&
      overrides.windowSeconds !== undefined
    ) {
      return {
        algorithm: overrides.algorithm,
        limit: overrides.limit,
        windowSeconds: overrides.windowSeconds,
        source: 'request',
      };
    }

    const match = await ruleEngineService.findMatchingRule({
      identifier: request.identifier,
      endpoint: request.endpoint,
      ip: request.ip,
      metadata: request.metadata,
    });

    if (match.matched && match.rule) {
      const rule = match.rule;
      metricsService.recordRuleMatch(rule.id, rule.name);
      return {
        // Explicit request fields still win field by field, so a caller can
        // override just the limit and inherit the rest of the rule.
        algorithm: overrides.algorithm ?? rule.algorithm,
        limit: overrides.limit ?? rule.limit,
        windowSeconds: overrides.windowSeconds ?? rule.windowSeconds,
        source: 'rule',
        ruleId: rule.id,
        ruleName: rule.name,
      };
    }

    metricsService.recordRuleMatch('none', 'default');
    return {
      algorithm: overrides.algorithm ?? config.defaults.algorithm,
      limit: overrides.limit ?? config.defaults.limit,
      windowSeconds: overrides.windowSeconds ?? config.defaults.windowSeconds,
      source: 'default',
    };
  }

  async check(
    request: RateLimitCheckRequest,
    overrides: CheckOverrides = {}
  ): Promise<RateLimitDecision> {
    const effective = await this.resolveLimit(request, overrides);
    const started = process.hrtime.bigint();

    try {
      const algorithm = AlgorithmFactory.getAlgorithm(effective.algorithm);
      const result = await algorithm.check(
        request.key,
        effective.limit,
        effective.windowSeconds
      );

      // hrtime, not Date.now(): the whole check is expected to land in single-digit
      // milliseconds, which a millisecond-resolution clock cannot measure.
      metricsService.recordCheckLatency(
        effective.algorithm,
        Number(process.hrtime.bigint() - started) / 1e9
      );
      metricsService.recordRequest(effective.algorithm, result.allowed);

      return { ...result, effective };
    } catch (error) {
      logger.error('Rate limit check failed', { key: request.key, error });
      metricsService.recordRedisError('check');
      throw error;
    }
  }

  async reset(
    key: string,
    algorithm: RateLimitAlgorithm,
    windowSeconds = config.defaults.windowSeconds
  ): Promise<void> {
    try {
      await AlgorithmFactory.getAlgorithm(algorithm).reset(key, windowSeconds);
      logger.info('Rate limit reset', { key, algorithm });
    } catch (error) {
      metricsService.recordRedisError('reset');
      throw error;
    }
  }

  async getStats(
    key: string,
    algorithm: RateLimitAlgorithm,
    windowSeconds = config.defaults.windowSeconds
  ): Promise<{ count: number; resetAt: number } | null> {
    try {
      return await AlgorithmFactory.getAlgorithm(algorithm).getStats(key, windowSeconds);
    } catch (error) {
      metricsService.recordRedisError('getStats');
      throw error;
    }
  }
}

export default new RateLimiterService();
