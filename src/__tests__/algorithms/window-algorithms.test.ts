import { SlidingWindowAlgorithm } from '../../algorithms/sliding-window';
import { FixedWindowAlgorithm } from '../../algorithms/fixed-window';
import redisService from '../../services/redis.service';
import { connectRedis, disconnectRedis, flush, sleep } from '../support/redis';

const sliding = new SlidingWindowAlgorithm();
const fixed = new FixedWindowAlgorithm();

beforeAll(connectRedis);
afterAll(disconnectRedis);
beforeEach(flush);

describe('SlidingWindowAlgorithm', () => {
  it('admits up to the limit and then rejects', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await sliding.check('sw', 3, 60)).allowed).toBe(true);
    }
    const rejected = await sliding.check('sw', 3, 60);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
  });

  /**
   * The property that distinguishes a sliding window from a fixed one: capacity
   * is returned gradually as individual requests age out, rather than all at
   * once on a boundary. A fixed window would allow a full second batch here.
   */
  it('releases capacity as individual requests age out, not in a batch', async () => {
    const limit = 3;
    const windowSeconds = 2;

    for (let i = 0; i < limit; i++) {
      await sliding.check('drip', limit, windowSeconds);
      await sleep(300);
    }
    expect((await sliding.check('drip', limit, windowSeconds)).allowed).toBe(false);

    // The oldest of the three was admitted ~900ms ago; wait out the rest of its
    // window and exactly one slot should reopen.
    await sleep(1300);
    expect((await sliding.check('drip', limit, windowSeconds)).allowed).toBe(true);
    expect((await sliding.check('drip', limit, windowSeconds)).allowed).toBe(false);
  });

  it('does not record rejected requests, so retrying cannot extend the window', async () => {
    await sliding.check('norec', 1, 60);
    for (let i = 0; i < 5; i++) await sliding.check('norec', 1, 60);

    const stats = await sliding.getStats('norec');
    expect(stats?.count).toBe(1);
  });

  it('admits exactly `limit` requests under concurrent load', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => sliding.check('sw-conc', 12, 3600))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(12);
  });

  it('rejects a weighted cost it cannot honestly account for', async () => {
    await expect(sliding.check('sw-cost', 10, 60, 5)).rejects.toThrow(/cost/);
  });
});

describe('FixedWindowAlgorithm', () => {
  it('admits up to the limit and then rejects', async () => {
    for (let i = 0; i < 2; i++) {
      expect((await fixed.check('fw', 2, 60)).allowed).toBe(true);
    }
    expect((await fixed.check('fw', 2, 60)).allowed).toBe(false);
  });

  it('resets on the window boundary', async () => {
    const windowSeconds = 1;
    await fixed.check('fw-boundary', 1, windowSeconds);
    expect((await fixed.check('fw-boundary', 1, windowSeconds)).allowed).toBe(false);

    // Sleep past the next boundary rather than a fixed duration; the window is
    // aligned to epoch time, not to when the first request arrived.
    const result = await fixed.check('fw-boundary', 1, windowSeconds);
    await sleep(Math.max(0, result.resetAt - Date.now()) + 50);
    expect((await fixed.check('fw-boundary', 1, windowSeconds)).allowed).toBe(true);
  });

  /**
   * The counter key must not outlive its window. The original implementation set
   * a full-window TTL on first write, so a key created just before a boundary
   * survived through most of the following window.
   */
  it('expires the counter no later than the window it belongs to', async () => {
    const windowSeconds = 10;
    await fixed.check('fw-ttl', 5, windowSeconds);

    const index = Math.floor(Date.now() / (windowSeconds * 1000));
    const pttl = await redisService
      .getClient()
      .pttl(`rate_limit:fixed_window:fw-ttl:${index}`);

    const msLeftInWindow = (index + 1) * windowSeconds * 1000 - Date.now();
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(msLeftInWindow + 50);
  });

  it('admits exactly `limit` requests under concurrent load', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => fixed.check('fw-conc', 9, 3600))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(9);
  });

  it('clears the current window on reset without scanning the keyspace', async () => {
    await fixed.check('fw-reset', 5, 60);
    expect(await fixed.getStats('fw-reset', 60)).toMatchObject({ count: 1 });

    await fixed.reset('fw-reset', 60);
    expect(await fixed.getStats('fw-reset', 60)).toBeNull();
  });
});
