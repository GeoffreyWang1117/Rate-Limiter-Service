import { randomUUID } from 'node:crypto';
import { RedisScript } from '../algorithms/script-runner';
import { ADMIT_SCRIPT, COMMIT_SCRIPT, SNAPSHOT_SCRIPT } from './admission-scripts';
import { estimateReservation } from './estimator';
import redisService from '../services/redis.service';
import metricsService from '../services/metrics.service';
import logger from '../utils/logger';
import {
  AdmissionPolicy,
  AdmissionRequest,
  AdmissionResult,
  CommitRequest,
  CommitResult,
  ShedReason,
} from './types';

const admitScript = new RedisScript(ADMIT_SCRIPT, 7, 'llm_admit');
const commitScript = new RedisScript(COMMIT_SCRIPT, 6, 'llm_commit');
const snapshotScript = new RedisScript(SNAPSHOT_SCRIPT, 6, 'llm_snapshot');

/** Expired leases swept per admission call. Bounds the tail latency of any single request. */
const RECLAIM_BATCH = 32;
/** Weight on the newest sample in the service-time and output-length EWMAs. */
const EWMA_ALPHA = 0.2;
/** Assumed service time before any completion has been observed. */
const COLD_START_SERVICE_MS = 2000;
/**
 * How long a settled reservation is remembered so a retried commit is
 * recognised. Only has to cover a client's retry horizon; every additional
 * second is one more second of keys held per commit.
 */
const IDEMPOTENCY_TTL_SECONDS = Number(process.env.COMMIT_IDEMPOTENCY_TTL ?? 300);

class LlmAdmissionService {
  /**
   * All keys for one (tenant, model) share a hash tag so Redis Cluster maps them
   * to a single slot. Without it a multi-key script spanning budgets, leases and
   * stats is rejected as a cross-slot command the moment the deployment grows
   * past one node.
   */
  private ns(tenant: string, model: string): string {
    return `llm:{${tenant}|${model}}`;
  }

  private keys(tenant: string, model: string) {
    const ns = this.ns(tenant, model);
    return {
      tpm: `${ns}:tpm`,
      tpmTs: `${ns}:tpm:ts`,
      rpm: `${ns}:rpm`,
      rpmTs: `${ns}:rpm:ts`,
      leases: `${ns}:leases`,
      reservations: `${ns}:res`,
      stats: `${ns}:stats`,
    };
  }

  /**
   * One key per settled reservation, sharing the tenant's hash tag so it lands
   * on the same Redis Cluster slot as the budget it settled against.
   */
  private settledKey(tenant: string, model: string, reservationId: string): string {
    return `${this.ns(tenant, model)}:settled:${reservationId}`;
  }

  /**
   * Budget keys must outlive the longest lease, otherwise a reservation could
   * come back to commit against a balance that has silently reset to full.
   */
  private ttlSeconds(policy: AdmissionPolicy): number {
    return Math.max(120, policy.leaseSeconds * 2 + 60);
  }

  async reserve(
    request: AdmissionRequest,
    policy: AdmissionPolicy
  ): Promise<AdmissionResult> {
    const { tenant, model, promptTokens, maxOutputTokens, sloTtftMs } = request;
    const k = this.keys(tenant, model);

    const observed = await this.observedOutputTokens(tenant, model, policy);
    const estimate = estimateReservation(policy, promptTokens, maxOutputTokens, observed);

    const reservationId = randomUUID();
    const now = Date.now();
    const leaseMs = policy.leaseSeconds * 1000;

    const raw = await admitScript.run<[number, string, number, number, number, number, number, number, number]>(
      [k.tpm, k.tpmTs, k.rpm, k.rpmTs, k.leases, k.reservations, k.stats],
      [
        now,
        policy.tokensPerMinute,
        policy.tokensPerMinute / 60,
        policy.requestsPerMinute,
        policy.requestsPerMinute / 60,
        estimate.reserveTokens,
        reservationId,
        leaseMs,
        policy.maxConcurrency,
        policy.maxQueueDepth,
        sloTtftMs ?? 0,
        this.ttlSeconds(policy),
        RECLAIM_BATCH,
        COLD_START_SERVICE_MS,
      ]
    );

    const [
      admitted,
      reason,
      reservedTokens,
      tokensRemaining,
      requestsRemaining,
      inflight,
      predictedWaitMs,
      retryAfterMs,
      reclaimed,
    ] = raw;

    metricsService.recordAdmission(
      tenant,
      model,
      admitted === 1 ? 'admit' : (reason as ShedReason)
    );
    if (reclaimed > 0) {
      metricsService.recordLeaseReclaim(tenant, model, reclaimed);
      logger.warn('Reclaimed expired reservations', { tenant, model, count: reclaimed });
    }
    if (admitted === 1) {
      metricsService.recordReservation(
        tenant,
        model,
        reservedTokens,
        estimate.worstCaseTokens
      );
      metricsService.setInflight(tenant, model, inflight);
    }

    return {
      decision: admitted === 1 ? 'admit' : 'shed',
      ...(admitted === 0 && { reason: reason as ShedReason }),
      ...(admitted === 1 && {
        reservationId,
        reservedTokens,
        leaseExpiresAt: now + leaseMs,
      }),
      tokensRemaining,
      requestsRemaining,
      inflight,
      predictedWaitMs,
      // `unsatisfiable` deliberately carries no Retry-After: the request is
      // larger than the budget can ever be, so telling the caller to retry
      // would just invite a hot loop.
      ...(retryAfterMs > 0 && { retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) }),
      reclaimed,
    };
  }

  /**
   * Reconciles a finished request against what it reserved. Must be called for
   * every admitted request, including failed ones -- `release` is the variant
   * for a request that generated nothing.
   */
  async commit(request: CommitRequest, policy: AdmissionPolicy): Promise<CommitResult> {
    const { tenant, model, reservationId, promptTokens, outputTokens, serviceMs } = request;
    const k = this.keys(tenant, model);
    const actual = promptTokens + outputTokens;

    const [status, refundedTokens, tokensRemaining, inflight] = await commitScript.run<
      [number, number, number, number]
    >(
      [
        k.tpm,
        k.tpmTs,
        k.leases,
        k.reservations,
        k.stats,
        this.settledKey(tenant, model, reservationId),
      ],
      [
        Date.now(),
        reservationId,
        actual,
        policy.tokensPerMinute,
        this.ttlSeconds(policy),
        serviceMs ?? 0,
        outputTokens,
        EWMA_ALPHA,
        IDEMPOTENCY_TTL_SECONDS,
      ]
    );

    if (status === 3) {
      return {
        status: 'duplicate_ignored',
        refundedTokens,
        tokensRemaining,
        inflight,
      };
    }
    if (status === 2) {
      logger.warn('Commit arrived after its lease expired', {
        tenant,
        model,
        reservationId,
        actual,
      });
      metricsService.recordLateCommit(tenant, model);
    }
    if (refundedTokens < 0) {
      // The caller produced more than the ceiling it declared. Worth surfacing:
      // it means the ceiling is not being enforced upstream at the model.
      metricsService.recordOverrun(tenant, model, -refundedTokens);
    }
    metricsService.setInflight(tenant, model, inflight);

    return {
      status: status === 2 ? 'reconciled_after_expiry' : 'committed',
      refundedTokens,
      tokensRemaining,
      inflight,
    };
  }

  /** Abandons a reservation without consuming it -- client disconnect, upstream error. */
  async release(
    tenant: string,
    model: string,
    reservationId: string,
    policy: AdmissionPolicy
  ): Promise<CommitResult> {
    return this.commit(
      { tenant, model, reservationId, promptTokens: 0, outputTokens: 0 },
      policy
    );
  }

  async snapshot(tenant: string, model: string, policy: AdmissionPolicy) {
    const k = this.keys(tenant, model);
    const [
      tokensRemaining,
      requestsRemaining,
      inflight,
      expiredLeases,
      avgServiceMs,
      avgOutputTokens,
      peakOutputTokens,
    ] = await snapshotScript.run<[number, number, number, number, number, number, number]>(
      [k.tpm, k.tpmTs, k.rpm, k.rpmTs, k.leases, k.stats],
      [
        Date.now(),
        policy.tokensPerMinute,
        policy.tokensPerMinute / 60,
        policy.requestsPerMinute,
        policy.requestsPerMinute / 60,
        COLD_START_SERVICE_MS,
      ]
    );

    return {
      tenant,
      model,
      tokensRemaining,
      requestsRemaining,
      inflight,
      /** Leases past their deadline that the next admission call will sweep. */
      expiredLeasesPending: expiredLeases,
      avgServiceMs,
      avgOutputTokens,
      peakOutputTokens,
      policy,
    };
  }

  private async observedOutputTokens(
    tenant: string,
    model: string,
    policy: AdmissionPolicy
  ): Promise<number> {
    if (policy.reservationMode !== 'adaptive') return 0;
    const value = await redisService
      .getClient()
      .hget(this.keys(tenant, model).stats, 'out_tokens');
    return value ? Number(value) : 0;
  }

  async warm(): Promise<void> {
    await Promise.all([admitScript.load(), commitScript.load(), snapshotScript.load()]);
  }
}

export default new LlmAdmissionService();
