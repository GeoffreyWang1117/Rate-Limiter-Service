/**
 * Admission control for an LLM inference gateway.
 *
 * A conventional API rate limiter charges each request one unit, decided once,
 * at arrival. Neither half of that holds for LLM traffic:
 *
 *  - Cost is tokens, not requests, and it varies by three orders of magnitude
 *    between a one-line completion and a 200k-token context. Counting requests
 *    lets a handful of large prompts exhaust a GPU while the request counter
 *    still reads nearly empty.
 *  - The dominant part of that cost -- output tokens -- is not known at arrival.
 *    It is only known when generation stops.
 *
 * So admission cannot be a single decision. It is a three-phase protocol:
 *
 *    reserve   charge the worst case (or an estimate) up front, hold it
 *    commit    reconcile against actual usage, refund or charge the difference
 *    expire    reclaim reservations whose owner never came back
 *
 * The third phase is what makes this a distributed-systems problem rather than
 * bookkeeping. Any client can crash, time out, or be killed between reserve and
 * commit. Without expiry, each such request permanently burns a slice of the
 * tenant's budget, and the tenant's effective quota decays toward zero with no
 * error anyone can point at.
 */

export type AdmissionDecision = 'admit' | 'shed';

export type ShedReason =
  /** Token-per-minute budget exhausted. */
  | 'tpm_exhausted'
  /** Request-per-minute budget exhausted. */
  | 'rpm_exhausted'
  /** Concurrency limit reached and the queue is full. */
  | 'queue_full'
  /**
   * A slot would eventually free up, but not before the caller's deadline.
   * Shedding now is strictly better than admitting: an accepted request that
   * later times out has still occupied a GPU slot for the whole wait.
   */
  | 'slo_infeasible'
  /** A single request larger than the tenant's entire budget; retrying cannot help. */
  | 'unsatisfiable';

export interface AdmissionRequest {
  tenant: string;
  model: string;
  /** Known exactly at arrival, from tokenizing the prompt. */
  promptTokens: number;
  /** Upper bound the caller has committed to. The unknown lives under this ceiling. */
  maxOutputTokens: number;
  /**
   * Deadline for the first output token. When set, the gateway sheds requests
   * it predicts cannot meet it instead of queueing them into a timeout.
   */
  sloTtftMs?: number;
}

export interface AdmissionResult {
  decision: AdmissionDecision;
  reason?: ShedReason;
  /** Present when admitted. Must be presented to commit or release. */
  reservationId?: string;
  /** Tokens held for this request until it commits. */
  reservedTokens?: number;
  /** Wall-clock deadline for the reservation; after this it is reclaimed. */
  leaseExpiresAt?: number;
  tokensRemaining: number;
  requestsRemaining: number;
  /** Requests admitted but not yet committed, across all gateway replicas. */
  inflight: number;
  /** Estimated wait before this request reaches a GPU slot. */
  predictedWaitMs: number;
  /** Seconds; only set when shed for a reason that retrying can resolve. */
  retryAfter?: number;
  /** Expired reservations swept during this call. Surfaced for observability. */
  reclaimed: number;
}

export interface CommitRequest {
  tenant: string;
  model: string;
  reservationId: string;
  /** Actual usage, known now that generation has finished. */
  promptTokens: number;
  outputTokens: number;
  /** End-to-end service time, used to keep the wait predictor calibrated. */
  serviceMs?: number;
}

export type CommitStatus =
  | 'committed'
  /**
   * The lease expired and its hold was already refunded before this commit
   * arrived. Actual usage is charged now so the tenant still pays for work the
   * GPU really did -- the alternative is free compute for anyone slow enough.
   */
  | 'reconciled_after_expiry'
  /**
   * This reservation was already settled. Commit is idempotent, so the retry is
   * acknowledged without touching the budget again.
   */
  | 'duplicate_ignored';

export interface CommitResult {
  status: CommitStatus;
  /** Reserved minus actual. Negative when the caller overran its declared ceiling. */
  refundedTokens: number;
  tokensRemaining: number;
  inflight: number;
}

/**
 * How much budget to hold at reserve time.
 *
 * `worst_case` holds promptTokens + maxOutputTokens. It can never overrun, but
 * callers habitually pass a max_tokens far above what they use, so most of a
 * tenant's budget sits held against output that is never generated.
 *
 * `adaptive` holds promptTokens + an estimate derived from what this model has
 * actually produced recently, with a safety margin, clamped to the declared
 * ceiling. It recovers most of that stranded budget; the cost is that an
 * underestimate is charged as an overrun at commit time.
 */
export type ReservationMode = 'worst_case' | 'adaptive';

export interface AdmissionPolicy {
  tenant: string;
  model: string;
  /** Token budget per minute. The binding constraint for most LLM workloads. */
  tokensPerMinute: number;
  /** Request budget per minute. Guards against many tiny requests. */
  requestsPerMinute: number;
  /** Concurrent in-flight requests the backend can serve, i.e. GPU slots. */
  maxConcurrency: number;
  /** Additional requests allowed to wait for a slot. */
  maxQueueDepth: number;
  /** How long a reservation is held before it is reclaimed. */
  leaseSeconds: number;
  reservationMode: ReservationMode;
  /** Multiplier applied to the estimate in `adaptive` mode. */
  reservationSafetyFactor: number;
  enabled: boolean;
}

export const DEFAULT_POLICY: Omit<AdmissionPolicy, 'tenant' | 'model'> = {
  tokensPerMinute: 100_000,
  requestsPerMinute: 600,
  maxConcurrency: 16,
  maxQueueDepth: 64,
  // Long enough to cover a slow generation, short enough that a crashed client
  // does not stall the tenant for minutes.
  leaseSeconds: 120,
  reservationMode: 'worst_case',
  reservationSafetyFactor: 1.5,
  enabled: true,
};
