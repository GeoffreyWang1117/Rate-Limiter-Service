import { Registry, Counter, Histogram, Gauge } from 'prom-client';
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

  // LLM admission control
  public admissionsTotal: Counter;
  public tokensReservedTotal: Counter;
  public tokensWorstCaseTotal: Counter;
  public leaseReclaimsTotal: Counter;
  public lateCommitsTotal: Counter;
  public overrunTokensTotal: Counter;
  public reservationsSettledTotal: Counter;
  public ruleMatchesTotal: Counter;
  public degradedResponsesTotal: Counter;
  public apiLatency: Histogram;

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

    this.admissionsTotal = new Counter({
      name: 'llm_admission_decisions_total',
      help: 'Admission decisions, labelled by outcome. `shed` outcomes carry the binding constraint.',
      labelNames: ['scope', 'outcome'],
      registers: [this.registry],
    });

    // Reserved vs worst-case, as two counters rather than a ratio gauge: the
    // ratio is only meaningful aggregated over a window, which is a job for the
    // query engine, not for the exporter.
    this.tokensReservedTotal = new Counter({
      name: 'llm_tokens_reserved_total',
      help: 'Tokens actually held at admission time',
      labelNames: ['scope'],
      registers: [this.registry],
    });

    this.tokensWorstCaseTotal = new Counter({
      name: 'llm_tokens_worst_case_total',
      help: 'Tokens that worst-case reservation would have held, for comparison against llm_tokens_reserved_total',
      labelNames: ['scope'],
      registers: [this.registry],
    });

    this.leaseReclaimsTotal = new Counter({
      name: 'llm_lease_reclaims_total',
      help: 'Expired reservations swept back into the budget. Sustained non-zero means clients are dying between reserve and commit.',
      labelNames: ['scope'],
      registers: [this.registry],
    });

    this.lateCommitsTotal = new Counter({
      name: 'llm_late_commits_total',
      help: 'Commits that arrived after their lease had already been reclaimed',
      labelNames: ['scope'],
      registers: [this.registry],
    });

    this.overrunTokensTotal = new Counter({
      name: 'llm_overrun_tokens_total',
      help: 'Tokens generated beyond what was reserved. Non-zero under adaptive reservation is expected; under worst_case it means max_tokens is not enforced upstream.',
      labelNames: ['scope'],
      registers: [this.registry],
    });

    // A counter, not a gauge, and this is load-bearing.
    //
    // `inflight` is a per-(tenant, model) ZCARD. Under a catch-all policy every
    // tenant resolves to the same scope, so a gauge set from that value has each
    // commit overwrite the series with one arbitrary pair's count: tenant A can
    // have 800 in flight and the series read 0 because tenant B just finished.
    // Counters aggregate instead of overwriting, so in-flight work is derived:
    //
    //   sum(llm_admission_decisions_total{outcome="admit"}) by (scope)
    //     - sum(llm_reservations_settled_total) by (scope)
    //     - sum(llm_lease_reclaims_total) by (scope)
    this.reservationsSettledTotal = new Counter({
      name: 'llm_reservations_settled_total',
      help: 'Reservations reconciled by a commit or a release. Admissions minus settlements minus reclaims is work in flight.',
      labelNames: ['scope'],
      registers: [this.registry],
    });

    this.ruleMatchesTotal = new Counter({
      name: 'rate_limiter_rule_matches_total',
      help: 'Rate limit decisions by the rule that governed them. `none` means no rule matched and defaults applied.',
      labelNames: ['rule_id', 'rule_name'],
      registers: [this.registry],
    });

    this.degradedResponsesTotal = new Counter({
      name: 'rate_limiter_degraded_responses_total',
      help: 'Responses served from the configured failure mode because limiter state was unreachable. Any non-zero rate means decisions are not being enforced.',
      labelNames: ['surface', 'mode'],
      registers: [this.registry],
    });

    this.apiLatency = new Histogram({
      name: 'rate_limiter_api_latency_seconds',
      help: 'End-to-end HTTP handler latency. Replaces the per-request access log on the data path.',
      labelNames: ['method', 'route', 'status_class'],
      // Buckets are dense below 25ms because that is where this service is
      // expected to live; the defaults start at 5ms and would put every normal
      // response in the first bucket.
      buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1, 5],
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

  recordApiLatency(method: string, route: string, seconds: number): void {
    // Status class rather than exact code: a histogram is already
    // multi-dimensional, and one series per status code per route per method
    // multiplies out fast.
    this.apiLatency.observe({ method, route, status_class: 'all' }, seconds);
  }

  updateActiveKeys(algorithm: string, count: number): void {
    this.activeKeys.set({ algorithm }, count);
  }

  /**
   * Admission metrics are labelled by policy scope, never by tenant or model.
   *
   * Those two arrive in an unauthenticated request body. Labelling by them meant
   * every distinct string minted a permanent time series -- the registry never
   * evicts -- so anyone able to reach /reserve could grow it without bound. The
   * set of configured policies is bounded and operator-defined, and it is the
   * dimension an operator can act on.
   */
  recordAdmission(scope: string, outcome: string): void {
    this.admissionsTotal.inc({ scope, outcome });
  }

  recordReservation(scope: string, reserved: number, worstCase: number): void {
    this.tokensReservedTotal.inc({ scope }, reserved);
    this.tokensWorstCaseTotal.inc({ scope }, worstCase);
  }

  recordLeaseReclaim(scope: string, count: number): void {
    this.leaseReclaimsTotal.inc({ scope }, count);
  }

  recordLateCommit(scope: string): void {
    this.lateCommitsTotal.inc({ scope });
  }

  recordOverrun(scope: string, tokens: number): void {
    this.overrunTokensTotal.inc({ scope }, tokens);
  }

  recordDegraded(surface: string, mode: string): void {
    this.degradedResponsesTotal.inc({ surface, mode });
  }

  recordRuleMatch(ruleId: string, ruleName: string): void {
    this.ruleMatchesTotal.inc({ rule_id: ruleId, rule_name: ruleName });
  }

  recordSettled(scope: string): void {
    this.reservationsSettledTotal.inc({ scope });
  }
}

export default new MetricsService();
