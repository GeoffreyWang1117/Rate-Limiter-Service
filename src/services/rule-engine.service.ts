import ruleRepository from '../repositories/rule.repository';
import {
  RateLimitRule,
  RuleMatchContext,
  RuleMatchResult,
  DimensionType,
} from '../types';
import logger from '../utils/logger';
import { matchPattern } from '../utils/pattern';

/**
 * Rule Engine Service
 * Handles rule matching and priority selection
 */
class RuleEngineService {
  private rulesCache: RateLimitRule[] = [];
  private cacheLastUpdated: number = 0;
  private readonly CACHE_TTL = 60000; // 60 seconds

  /**
   * Find the best matching rule for a given context
   */
  async findMatchingRule(context: RuleMatchContext): Promise<RuleMatchResult> {
    try {
      // Get enabled rules (from cache or database)
      const rules = await this.getEnabledRules();

      // Try to find a matching rule (highest priority first)
      for (const rule of rules) {
        if (this.isRuleMatch(rule, context)) {
          logger.debug('Rule matched', {
            ruleId: rule.id,
            ruleName: rule.name,
            context,
          });

          return {
            matched: true,
            rule,
          };
        }
      }

      // No match found
      logger.debug('No matching rule found', { context });

      return {
        matched: false,
        reason: 'No matching rule found',
      };
    } catch (error) {
      logger.error('Failed to find matching rule:', error);
      throw error;
    }
  }

  /**
   * Check if a rule matches the given context
   */
  private isRuleMatch(rule: RateLimitRule, context: RuleMatchContext): boolean {
    const { type, pattern } = rule.dimension;

    switch (type) {
      case DimensionType.GLOBAL:
        // Global rules always match
        return true;

      case DimensionType.USER:
        // Match by user identifier
        if (!pattern) return true;
        return this.matchPattern(context.identifier, pattern);

      case DimensionType.IP:
        // Match by IP address
        if (!context.ip) return false;
        if (!pattern) return true;
        return this.matchPattern(context.ip, pattern);

      case DimensionType.ENDPOINT:
        // Match by endpoint path
        if (!context.endpoint) return false;
        if (!pattern) return true;
        return this.matchPattern(context.endpoint, pattern);

      case DimensionType.CUSTOM:
        // Custom matching logic
        if (!pattern) return false;
        return this.matchCustomPattern(context, pattern);

      default:
        logger.warn('Unknown dimension type', { type });
        return false;
    }
  }

  /**
   * Delegates to the shared matcher. The previous implementation built its
   * regex by escaping dots and nothing else, so an operator pattern containing
   * `+`, `(` or `|` was silently interpreted as a regex -- either matching far
   * more than intended or throwing on every request that reached it.
   */
  private matchPattern(value: string, pattern: string): boolean {
    return matchPattern(value, pattern);
  }

  /**
   * Custom pattern matching using metadata
   */
  private matchCustomPattern(context: RuleMatchContext, pattern: string): boolean {
    try {
      // Pattern format: "metadata.key=value" or "metadata.key~regex"
      const [key, operator, value] = this.parseCustomPattern(pattern);

      if (!context.metadata || !context.metadata[key]) {
        return false;
      }

      const metadataValue = String(context.metadata[key]);

      switch (operator) {
        case '=':
          return metadataValue === value;
        case '~': {
          const regex = new RegExp(value);
          return regex.test(metadataValue);
        }
        default:
          return false;
      }
    } catch (error) {
      logger.error('Failed to match custom pattern', { pattern, error });
      return false;
    }
  }

  /**
   * Parse custom pattern string
   */
  private parseCustomPattern(pattern: string): [string, string, string] {
    // Try "=" operator first
    const equalsMatch = pattern.match(/^(\w+)=(.+)$/);
    if (equalsMatch) {
      return [equalsMatch[1], '=', equalsMatch[2]];
    }

    // Try "~" operator (regex)
    const regexMatch = pattern.match(/^(\w+)~(.+)$/);
    if (regexMatch) {
      return [regexMatch[1], '~', regexMatch[2]];
    }

    throw new Error(`Invalid custom pattern format: ${pattern}`);
  }

  /**
   * Get enabled rules (with caching)
   */
  private async getEnabledRules(): Promise<RateLimitRule[]> {
    const now = Date.now();

    // Return cached rules if still valid
    if (
      this.rulesCache.length > 0 &&
      now - this.cacheLastUpdated < this.CACHE_TTL
    ) {
      return this.rulesCache;
    }

    // Fetch from database
    const rules = await ruleRepository.findEnabledRulesByPriority();

    // Update cache
    this.rulesCache = rules;
    this.cacheLastUpdated = now;

    logger.debug('Rules cache updated', { count: rules.length });

    return rules;
  }

  /**
   * Invalidate rules cache (call this after rule updates)
   */
  invalidateCache(): void {
    this.rulesCache = [];
    this.cacheLastUpdated = 0;
    logger.info('Rules cache invalidated');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    cachedRules: number;
    lastUpdated: Date | null;
    isExpired: boolean;
  } {
    const now = Date.now();
    const isExpired = now - this.cacheLastUpdated > this.CACHE_TTL;

    return {
      cachedRules: this.rulesCache.length,
      lastUpdated: this.cacheLastUpdated > 0 ? new Date(this.cacheLastUpdated) : null,
      isExpired,
    };
  }
}

export default new RuleEngineService();
