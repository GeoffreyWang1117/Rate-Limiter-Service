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
  metadata?: Record<string, unknown>;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
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
  monitoring: {
    enabled: boolean;
    metricsPort: number;
  };
  logging: {
    level: string;
    format: string;
  };
}

export interface IRateLimitAlgorithm {
  check(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<RateLimitCheckResult>;
  reset(key: string): Promise<void>;
  getStats(key: string): Promise<{ count: number; resetAt: number } | null>;
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
