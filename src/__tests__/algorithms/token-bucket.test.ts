import { TokenBucketAlgorithm } from '../../algorithms/token-bucket';
import { connectRedis, disconnectRedis, flush, sleep } from '../support/redis';

const bucket = new TokenBucketAlgorithm();

beforeAll(connectRedis);
afterAll(disconnectRedis);
beforeEach(flush);

describe('TokenBucketAlgorithm', () => {
  it('admits a burst up to capacity and then rejects', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await bucket.check('burst', 5, 60));
    }

    expect(results.slice(0, 5).map((r) => r.allowed)).toEqual([true, true, true, true, true]);
    expect(results[5].allowed).toBe(false);
    expect(results[4].remaining).toBe(0);
    expect(results[5].retryAfter).toBeGreaterThan(0);
  });

  /**
   * Regression test for the defect this service shipped with.
   *
   * The bucket accrued `floor(elapsed_seconds * refill_rate)` tokens and then
   * advanced its clock to now on every admitted call. With a 1 token/s refill
   * and requests arriving every 667ms, `floor(0.667)` is 0 -- so the bucket
   * never refilled while it still had tokens, drained roughly 3x too fast, and
   * started returning 429 to traffic that was inside its configured budget.
   *
   * Offered load here is 1.5 req/s against a 10-token bucket refilling at
   * 1 token/s: a net drain of 0.5 tokens/s, so a correct limiter still has ~4
   * tokens left after 12s and rejects nothing. The pre-fix implementation
   * drained at the full 1.5 req/s and began rejecting at ~6.7s -- comfortably
   * inside this window, which is what makes this a regression test rather than
   * a restatement of current behaviour.
   */
  it('does not reject traffic that is inside its budget (fractional refill)', async () => {
    const limit = 10;
    const windowSeconds = 10; // => 1 token/s
    const offeredIntervalMs = 667; // => ~1.5 req/s
    const durationMs = 12_000;

    let admitted = 0;
    let rejected = 0;
    const started = Date.now();
    while (Date.now() - started < durationMs) {
      const result = await bucket.check('conformance', limit, windowSeconds);
      result.allowed ? admitted++ : rejected++;
      await sleep(offeredIntervalMs);
    }

    expect(rejected).toBe(0);
    expect(admitted).toBeGreaterThan(15);
  });

  it('accrues fractional tokens across calls that individually earn less than one', async () => {
    // 1 token/s. Drain the bucket, then make five 300ms-spaced probes. Each probe
    // earns 0.3 tokens; a floor()-based refill would earn 0 every time and never
    // recover. After ~1.5s of accrual the bucket owes one token.
    await bucket.check('fractional', 1, 1);

    let recovered = false;
    for (let i = 0; i < 5; i++) {
      await sleep(300);
      if ((await bucket.check('fractional', 1, 1)).allowed) {
        recovered = true;
        break;
      }
    }
    expect(recovered).toBe(true);
  });

  it('charges a weighted cost against the same budget', async () => {
    // 100-token budget: one 90-token request fits, a second does not, but a
    // 10-token request still does.
    expect((await bucket.check('weighted', 100, 60, 90)).allowed).toBe(true);
    expect((await bucket.check('weighted', 100, 60, 90)).allowed).toBe(false);

    const small = await bucket.check('weighted', 100, 60, 10);
    expect(small.allowed).toBe(true);
    expect(small.remaining).toBe(0);
  });

  it('rejects a single request larger than the whole bucket rather than stalling', async () => {
    const result = await bucket.check('oversized', 10, 60, 11);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  /**
   * The read-modify-write has to be atomic. If the refill/compare/deduct ran in
   * application code, concurrent callers would each read the same balance and
   * over-admit by the number of concurrent callers.
   */
  it('admits exactly `limit` requests under concurrent load', async () => {
    const limit = 25;
    const results = await Promise.all(
      Array.from({ length: 200 }, () => bucket.check('concurrent', limit, 3600))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(limit);
  });

  it('reports stats and clears them on reset', async () => {
    await bucket.check('stats', 10, 60);
    expect(await bucket.getStats('stats')).toMatchObject({ count: 9 });

    await bucket.reset('stats');
    expect(await bucket.getStats('stats')).toBeNull();
  });
});
