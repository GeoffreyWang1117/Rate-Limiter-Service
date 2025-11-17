import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import config from '../config';
import logger from '../utils/logger';

class MetricsService {
  private registry: Registry;

  // Counters
  public requestsTotal: Counter;
  public blockedRequestsTotal: Counter;
  public redisErrorsTotal: Counter;
  public apiRequestsTotal: Counter;

  // Histograms
  public checkLatency: Histogram;
  public redisLatency: Histogram;

  // Gauges
  public activeKeys: Gauge;

  constructor() {
    this.registry = new Registry();

    // Initialize metrics
    this.requestsTotal = new Counter({
      name: 'rate_limiter_requests_total',
      help: 'Total number of rate limit check requests',
      labelNames: ['algorithm', 'result'],
      registers: [this.registry],
    });

    this.blockedRequestsTotal = new Counter({
      name: 'rate_limiter_blocked_requests_total',
      help: 'Total number of blocked requests due to rate limiting',
      labelNames: ['algorithm', 'key'],
      registers: [this.registry],
    });

    this.redisErrorsTotal = new Counter({
      name: 'rate_limiter_redis_errors_total',
      help: 'Total number of Redis errors',
      labelNames: ['operation'],
      registers: [this.registry],
    });

    this.apiRequestsTotal = new Counter({
      name: 'rate_limiter_api_requests_total',
      help: 'Total number of API requests',
      labelNames: ['method', 'path', 'status'],
      registers: [this.registry],
    });

    this.checkLatency = new Histogram({
      name: 'rate_limiter_check_latency_seconds',
      help: 'Rate limit check latency in seconds',
      labelNames: ['algorithm'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [this.registry],
    });

    this.redisLatency = new Histogram({
      name: 'rate_limiter_redis_latency_seconds',
      help: 'Redis operation latency in seconds',
      labelNames: ['operation'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [this.registry],
    });

    this.activeKeys = new Gauge({
      name: 'rate_limiter_active_keys',
      help: 'Number of active rate limit keys',
      labelNames: ['algorithm'],
      registers: [this.registry],
    });

    logger.info('Metrics service initialized');
  }

  getRegistry(): Registry {
    return this.registry;
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  recordRequest(algorithm: string, allowed: boolean): void {
    this.requestsTotal.inc({ algorithm, result: allowed ? 'allowed' : 'blocked' });

    if (!allowed) {
      this.blockedRequestsTotal.inc({ algorithm, key: 'unknown' });
    }
  }

  recordCheckLatency(algorithm: string, durationSeconds: number): void {
    this.checkLatency.observe({ algorithm }, durationSeconds);
  }

  recordRedisLatency(operation: string, durationSeconds: number): void {
    this.redisLatency.observe({ operation }, durationSeconds);
  }

  recordRedisError(operation: string): void {
    this.redisErrorsTotal.inc({ operation });
  }

  recordApiRequest(method: string, path: string, status: number): void {
    this.apiRequestsTotal.inc({ method, path, status: status.toString() });
  }

  updateActiveKeys(algorithm: string, count: number): void {
    this.activeKeys.set({ algorithm }, count);
  }
}

export default new MetricsService();
