import admission from '../../llm/admission.service';
import redisService from '../../services/redis.service';
import { AdmissionPolicy, DEFAULT_POLICY } from '../../llm/types';
import { connectRedis, disconnectRedis, flush, sleep } from '../support/redis';

const policy = (over: Partial<AdmissionPolicy> = {}): AdmissionPolicy => ({
  ...DEFAULT_POLICY,
  tenant: 'acme',
  model: 'test-model',
  ...over,
});

beforeAll(connectRedis);
afterAll(disconnectRedis);
beforeEach(flush);

const req = (over = {}) => ({
  tenant: 'acme',
  model: 'test-model',
  promptTokens: 100,
  maxOutputTokens: 400,
  ...over,
});

describe('reserve', () => {
  it('admits within budget and holds prompt + max output', async () => {
    const p = policy({ tokensPerMinute: 10_000 });
    const result = await admission.reserve(req(), p);

    expect(result.decision).toBe('admit');
    expect(result.reservedTokens).toBe(500);
    expect(result.tokensRemaining).toBe(9_500);
    expect(result.reservationId).toBeDefined();
    expect(result.inflight).toBe(1);
  });

  /**
   * The distinction that motivates the whole layer: a request-per-minute counter
   * cannot see the difference between these two, but the token budget can.
   */
  it('charges by tokens, so a few large requests exhaust what many small ones would not', async () => {
    const p = policy({ tokensPerMinute: 2_000, requestsPerMinute: 10_000 });

    const large = await admission.reserve(
      req({ promptTokens: 1_800, maxOutputTokens: 100 }),
      p
    );
    expect(large.decision).toBe('admit');

    const next = await admission.reserve(
      req({ promptTokens: 1_800, maxOutputTokens: 100 }),
      p
    );
    expect(next.decision).toBe('shed');
    expect(next.reason).toBe('tpm_exhausted');
    expect(next.retryAfter).toBeGreaterThan(0);

    // Request budget is nearly untouched -- an RPM-only limiter would have
    // admitted both and let the backend absorb 3,800 tokens of overload.
    expect(next.requestsRemaining).toBeGreaterThan(9_990);
  });

  it('sheds on the request budget independently of the token budget', async () => {
    const p = policy({ tokensPerMinute: 10_000_000, requestsPerMinute: 2 });
    await admission.reserve(req({ promptTokens: 1, maxOutputTokens: 1 }), p);
    await admission.reserve(req({ promptTokens: 1, maxOutputTokens: 1 }), p);

    const third = await admission.reserve(req({ promptTokens: 1, maxOutputTokens: 1 }), p);
    expect(third.decision).toBe('shed');
    expect(third.reason).toBe('rpm_exhausted');
  });

  it('refuses a request larger than the entire budget without telling it to retry', async () => {
    const p = policy({ tokensPerMinute: 1_000 });
    const result = await admission.reserve(
      req({ promptTokens: 5_000, maxOutputTokens: 100 }),
      p
    );

    expect(result.decision).toBe('shed');
    expect(result.reason).toBe('unsatisfiable');
    // Retrying can never succeed, so no Retry-After: advertising one invites a hot loop.
    expect(result.retryAfter).toBeUndefined();
  });

  it('admits exactly what the budget allows under concurrent load', async () => {
    // 10,000 tokens, 500 per request => exactly 20 fit. 60 callers race for them.
    const p = policy({ tokensPerMinute: 10_000, requestsPerMinute: 100_000, maxConcurrency: 1_000 });
    const results = await Promise.all(
      Array.from({ length: 60 }, () => admission.reserve(req(), p))
    );

    expect(results.filter((r) => r.decision === 'admit')).toHaveLength(20);
    expect(results.filter((r) => r.reason === 'tpm_exhausted')).toHaveLength(40);
  });
});

describe('concurrency and SLO', () => {
  it('sheds once concurrency and queue are both full', async () => {
    const p = policy({ maxConcurrency: 2, maxQueueDepth: 1, tokensPerMinute: 10_000_000 });

    for (let i = 0; i < 3; i++) {
      expect((await admission.reserve(req(), p)).decision).toBe('admit');
    }
    const shed = await admission.reserve(req(), p);
    expect(shed.decision).toBe('shed');
    expect(shed.reason).toBe('queue_full');
  });

  it('reports zero predicted wait while slots are free', async () => {
    const p = policy({ maxConcurrency: 4, tokensPerMinute: 10_000_000 });
    const result = await admission.reserve(req(), p);
    expect(result.predictedWaitMs).toBe(0);
  });

  /**
   * Once every slot is busy a new request has to wait for one to free. If that
   * predicted wait already exceeds the caller's deadline, admitting it would
   * occupy a slot to produce a response nobody is still waiting for.
   */
  it('sheds a request whose deadline cannot be met rather than queueing it into a timeout', async () => {
    const p = policy({
      maxConcurrency: 1,
      maxQueueDepth: 50,
      tokensPerMinute: 10_000_000,
    });

    // Fill the single slot, then queue enough work that the wait is long.
    for (let i = 0; i < 6; i++) {
      expect((await admission.reserve(req(), p)).decision).toBe('admit');
    }

    // No deadline: the caller is willing to wait, so it is queued.
    const patient = await admission.reserve(req(), p);
    expect(patient.decision).toBe('admit');
    expect(patient.predictedWaitMs).toBeGreaterThan(0);

    // A 500ms deadline against a multi-second predicted wait is infeasible.
    const impatient = await admission.reserve(req({ sloTtftMs: 500 }), p);
    expect(impatient.decision).toBe('shed');
    expect(impatient.reason).toBe('slo_infeasible');
    expect(impatient.predictedWaitMs).toBeGreaterThan(500);
  });
});

describe('commit', () => {
  it('refunds the difference between what was held and what was used', async () => {
    const p = policy({ tokensPerMinute: 10_000 });
    const reserved = await admission.reserve(req(), p);
    expect(reserved.tokensRemaining).toBe(9_500);

    // Held 500 (100 prompt + 400 max output), actually generated 37.
    const result = await admission.commit(
      {
        tenant: 'acme',
        model: 'test-model',
        reservationId: reserved.reservationId!,
        promptTokens: 100,
        outputTokens: 37,
      },
      p
    );

    expect(result.status).toBe('committed');
    expect(result.refundedTokens).toBe(363);
    expect(result.tokensRemaining).toBe(9_863);
    expect(result.inflight).toBe(0);
  });

  it('charges an overrun as a negative refund instead of writing it off', async () => {
    const p = policy({ tokensPerMinute: 10_000, reservationMode: 'adaptive' });
    const reserved = await admission.reserve(req({ maxOutputTokens: 50 }), p);

    const result = await admission.commit(
      {
        tenant: 'acme',
        model: 'test-model',
        reservationId: reserved.reservationId!,
        promptTokens: 100,
        outputTokens: 300, // beyond the declared ceiling
      },
      p
    );

    expect(result.refundedTokens).toBeLessThan(0);
    expect(result.tokensRemaining).toBe(10_000 - 400);
  });

  it('releases the whole hold when a request is abandoned', async () => {
    const p = policy({ tokensPerMinute: 10_000 });
    const reserved = await admission.reserve(req(), p);

    const result = await admission.release(
      'acme',
      'test-model',
      reserved.reservationId!,
      p
    );

    expect(result.refundedTokens).toBe(500);
    expect(result.tokensRemaining).toBe(10_000);
    expect(result.inflight).toBe(0);
  });
});

describe('lease expiry', () => {
  /**
   * The failure this protects against: a client crashes after being admitted and
   * never commits. Its hold is never returned, so the tenant's usable budget
   * shrinks with every crash until it reaches zero -- with no error to point at,
   * because every individual decision was correct.
   */
  it('reclaims budget held by reservations that were never committed', async () => {
    const p = policy({
      tokensPerMinute: 10_000,
      leaseSeconds: 1,
      requestsPerMinute: 100_000,
    });

    // Twenty callers take the whole budget and all of them vanish.
    for (let i = 0; i < 20; i++) {
      expect((await admission.reserve(req(), p)).decision).toBe('admit');
    }
    const starved = await admission.reserve(req(), p);
    expect(starved.decision).toBe('shed');
    expect(starved.reason).toBe('tpm_exhausted');

    await sleep(1_200);

    const afterExpiry = await admission.reserve(req(), p);
    expect(afterExpiry.decision).toBe('admit');
    expect(afterExpiry.reclaimed).toBe(20);
    expect(afterExpiry.inflight).toBe(1);
  });

  it('still charges a commit that arrives after its lease was reclaimed', async () => {
    const p = policy({ tokensPerMinute: 10_000, leaseSeconds: 1 });
    const reserved = await admission.reserve(req(), p);

    await sleep(1_200);
    // Any admission call sweeps the expired lease and refunds its hold.
    await admission.reserve(req({ promptTokens: 1, maxOutputTokens: 1 }), p);

    const result = await admission.commit(
      {
        tenant: 'acme',
        model: 'test-model',
        reservationId: reserved.reservationId!,
        promptTokens: 100,
        outputTokens: 200,
      },
      p
    );

    // The generation really happened, so it is billed even though the hold is gone.
    expect(result.status).toBe('reconciled_after_expiry');
    expect(result.refundedTokens).toBe(-300);
  });

  /**
   * Commit is called by a client that has just waited out a slow generation --
   * precisely when its own request times out and gets retried. A non-idempotent
   * commit would bill that completion twice, and only under the conditions that
   * are hardest to reproduce.
   */
  it('is idempotent: a retried commit does not charge the tenant twice', async () => {
    const p = policy({ tokensPerMinute: 10_000 });
    const reserved = await admission.reserve(req(), p);
    const commitArgs = {
      tenant: 'acme',
      model: 'test-model',
      reservationId: reserved.reservationId!,
      promptTokens: 100,
      outputTokens: 150,
    };

    const first = await admission.commit(commitArgs, p);
    const retry = await admission.commit(commitArgs, p);

    // Held 500, used 250, so 250 comes back.
    expect(first.status).toBe('committed');
    expect(first.refundedTokens).toBe(250);
    expect(first.tokensRemaining).toBe(9_750);

    expect(retry.status).toBe('duplicate_ignored');
    expect(retry.tokensRemaining).toBe(first.tokensRemaining);
  });

  /**
   * The record that makes commit idempotent has to expire on its own.
   *
   * It was first written as a field in a per-tenant hash. Hash fields have no
   * individual TTL, so the ledger grew with throughput for the whole life of the
   * hash: a 3k commits/s benchmark left 218k fields under one tenant, and the
   * rehashing surfaced as multi-second tail latency on admission -- a failure no
   * functional test would have caught, because every commit was still correct.
   */
  it('bounds the idempotency record with its own expiry', async () => {
    const p = policy({ tokensPerMinute: 100_000 });
    const reserved = await admission.reserve(req(), p);
    await admission.commit(
      {
        tenant: 'acme',
        model: 'test-model',
        reservationId: reserved.reservationId!,
        promptTokens: 100,
        outputTokens: 10,
      },
      p
    );

    const redis = redisService.getClient();
    const keys = await redis.keys('llm:*:settled:*');
    expect(keys).toHaveLength(1);

    const ttl = await redis.ttl(keys[0]);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });
});

describe('adaptive reservation', () => {
  it('holds the declared ceiling until it has observed real completions', async () => {
    const p = policy({ reservationMode: 'adaptive', tokensPerMinute: 1_000_000 });
    const cold = await admission.reserve(req({ maxOutputTokens: 4_000 }), p);
    expect(cold.reservedTokens).toBe(4_100);
  });

  it('holds materially less than the ceiling once completions are observed', async () => {
    const p = policy({
      reservationMode: 'adaptive',
      tokensPerMinute: 1_000_000,
      reservationSafetyFactor: 1.5,
    });

    // Callers ask for a 4,000-token ceiling but consistently generate ~200.
    for (let i = 0; i < 12; i++) {
      const r = await admission.reserve(req({ maxOutputTokens: 4_000 }), p);
      await admission.commit(
        {
          tenant: 'acme',
          model: 'test-model',
          reservationId: r.reservationId!,
          promptTokens: 100,
          outputTokens: 200,
          serviceMs: 800,
        },
        p
      );
    }

    const calibrated = await admission.reserve(req({ maxOutputTokens: 4_000 }), p);
    // ~200 observed * 1.5 safety + 100 prompt, versus 4,100 worst case.
    expect(calibrated.reservedTokens).toBeLessThan(1_000);
    expect(calibrated.reservedTokens).toBeGreaterThan(200);
  });

  it('never holds more than the caller declared', async () => {
    const p = policy({ reservationMode: 'adaptive', tokensPerMinute: 1_000_000 });
    for (let i = 0; i < 8; i++) {
      const r = await admission.reserve(req({ maxOutputTokens: 4_000 }), p);
      await admission.commit(
        {
          tenant: 'acme',
          model: 'test-model',
          reservationId: r.reservationId!,
          promptTokens: 100,
          outputTokens: 3_900,
        },
        p
      );
    }

    // The estimate * 1.5 now exceeds the ceiling; the hold must clamp to it.
    const clamped = await admission.reserve(req({ maxOutputTokens: 4_000 }), p);
    expect(clamped.reservedTokens).toBe(4_100);
  });
});

describe('snapshot', () => {
  it('reports live budget and in-flight state without consuming budget', async () => {
    const p = policy({ tokensPerMinute: 10_000 });
    await admission.reserve(req(), p);

    const before = await admission.snapshot('acme', 'test-model', p);
    const after = await admission.snapshot('acme', 'test-model', p);

    expect(before.inflight).toBe(1);
    expect(before.tokensRemaining).toBeLessThanOrEqual(9_500);
    expect(after.requestsRemaining).toBe(before.requestsRemaining);
  });
});
