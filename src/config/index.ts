import dotenv from 'dotenv';
import { RateLimiterConfig, RateLimitAlgorithm } from '../types';

dotenv.config();

const config: RateLimiterConfig = {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    maxRetries: parseInt(process.env.REDIS_MAX_RETRIES || '3', 10),
    retryDelay: parseInt(process.env.REDIS_RETRY_DELAY || '100', 10),
  },
  postgres: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'rate_limiter',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    maxConnections: parseInt(process.env.POSTGRES_MAX_CONNECTIONS || '20', 10),
    idleTimeout: parseInt(process.env.POSTGRES_IDLE_TIMEOUT || '30000', 10),
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    env: process.env.NODE_ENV || 'development',
  },
  defaults: {
    algorithm:
      (process.env.DEFAULT_ALGORITHM as RateLimitAlgorithm) ||
      RateLimitAlgorithm.TOKEN_BUCKET,
    limit: parseInt(process.env.DEFAULT_RATE_LIMIT || '1000', 10),
    windowSeconds: parseInt(process.env.DEFAULT_WINDOW_SECONDS || '60', 10),
  },
  auth: {
    /**
     * Shared secret for the control plane. Absent in development means the
     * control plane is open; absent in production means it is closed.
     */
    controlPlaneKey: process.env.CONTROL_PLANE_API_KEY || undefined,
  },
  monitoring: {
    // Defaults on. The previous default was off unless the string was exactly
    // 'true', so a deployment that simply omitted the variable ran blind.
    enabled: process.env.ENABLE_METRICS !== 'false',
  },
  /**
   * What to do when Redis is unreachable.
   *
   * `fail_open` keeps traffic flowing and stops the limiter from being a single
   * point of failure for the service it fronts. `fail_closed` refuses traffic it
   * cannot account for, which is the right choice when what sits behind the
   * limiter is scarce and expensive -- an unmetered flood into a GPU fleet costs
   * far more than the requests it drops.
   *
   * Defaults to fail_open for the generic HTTP limiter and fail_closed for LLM
   * admission, because the downstream cost profiles genuinely differ.
   */
  failure: {
    rateLimit:
      (process.env.RATE_LIMIT_FAILURE_MODE as 'fail_open' | 'fail_closed') || 'fail_open',
    admission:
      (process.env.ADMISSION_FAILURE_MODE as 'fail_open' | 'fail_closed') ||
      'fail_closed',
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'json',
  },
};

export default config;
