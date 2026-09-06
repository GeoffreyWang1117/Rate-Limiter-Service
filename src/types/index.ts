/**
 * Core types and interfaces for the Rate Limiter Service
 */

export enum RateLimitAlgorithm {
  TOKEN_BUCKET = 'token_bucket',
  SLIDING_WINDOW = 'sliding_window',
  FIXED_WINDOW = 'fixed_window',
  LEAKY_BUCKET = 'leaky_bucket',
}

export enum DimensionType {
  USER = 'user',
  IP = 'ip',
  ENDPOINT = 'endpoint',
  GLOBAL = 'global',
  CUSTOM = 'custom',
}

export interface RateLimitRule {
  id: string;
  name: string;
  algorithm: RateLimitAlgorithm;
  limit: number;
  windowSeconds: number;
  dimension: {
    type: DimensionType;
    pattern?: string;
  };
  priority: number;
  enabled: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface RateLimitCheckRequest {
  key: string;
  identifier: string;
  endpoint?: string;
  /** Client address, for rules scoped to the IP dimension. */
  ip?: string;
  metadata?: Record<string, unknown>;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms at which the caller regains full capacity. */
  resetAt: number;
  /** Seconds, for the `Retry-After` header, which has second granularity. */
  retryAfter?: number;
  /** Millisecond-precision form of `retryAfter`, for internal scheduling. */
  retryAfterMs?: number;
}

export interface TokenBucketState {
  tokens: number;
  lastRefillTime: number;
}

export interface RateLimiterConfig {
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
    maxRetries: number;
    retryDelay: number;
  };
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    maxConnections: number;
    idleTimeout: number;
  };
  server: {
    port: number;
    host: string;
    env: string;
  };
  defaults: {
    algorithm: RateLimitAlgorithm;
    limit: number;
    windowSeconds: number;
  };
  auth: {
    controlPlaneKey?: string;
  };
  monitoring: {
    enabled: boolean;
  };
  failure: {
    rateLimit: 'fail_open' | 'fail_closed';
    admission: 'fail_open' | 'fail_closed';
  };
  logging: {
    level: string;
    format: string;
  };
}

export interface IRateLimitAlgorithm {
  /**
   * @param cost units of budget this call consumes. Only the token bucket
   *   supports a value other than 1; counting algorithms reject it rather than
   *   silently under-charging.
   */
  check(
    key: string,
    limit: number,
    windowSeconds: number,
    cost?: number
  ): Promise<RateLimitCheckResult>;
  reset(key: string, windowSeconds?: number): Promise<void>;
  getStats(
    key: string,
    windowSeconds?: number
  ): Promise<{ count: number; resetAt: number } | null>;
  /** Pre-loads the algorithm's Lua script into the Redis script cache. */
  warm(): Promise<void>;
}

export interface RedisLuaScript {
  script: string;
  numberOfKeys: number;
}

// Rule Management Types
export interface CreateRuleRequest {
  name: string;
  description?: string;
  algorithm: RateLimitAlgorithm;
  limit: number;
  windowSeconds: number;
  dimensionType: DimensionType;
  dimensionPattern?: string;
  priority?: number;
  enabled?: boolean;
  tags?: string[];
}

export interface UpdateRuleRequest {
  name?: string;
  description?: string;
  algorithm?: RateLimitAlgorithm;
  limit?: number;
  windowSeconds?: number;
  dimensionType?: DimensionType;
  dimensionPattern?: string;
  priority?: number;
  enabled?: boolean;
  tags?: string[];
}

export interface RuleMatchContext {
  identifier: string;
  endpoint?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
}

export interface RuleMatchResult {
  matched: boolean;
  rule?: RateLimitRule;
  reason?: string;
}
