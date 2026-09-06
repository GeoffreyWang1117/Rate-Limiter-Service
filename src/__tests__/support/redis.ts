import redisService from '../../services/redis.service';

/**
 * These tests run against a real Redis, not a mock.
 *
 * A mocked `eval` can only ever confirm that we passed the arguments we
 * intended to pass -- it re-states the implementation instead of checking it.
 * Every defect worth catching here (fractional token accrual, TTL arithmetic,
 * atomicity under concurrency, Lua number coercion) lives inside the Redis
 * server, so the server has to be in the loop.
 *
 * `scripts/devstack.sh up` provides it locally; CI provides it as a service
 * container. DB 15 is used so a stray run cannot touch application data.
 */
export async function connectRedis(): Promise<void> {
  await redisService.connect();
}

export async function disconnectRedis(): Promise<void> {
  await redisService.disconnect();
}

export async function flush(): Promise<void> {
  await redisService.getClient().flushdb();
}

/** Wall-clock sleep. Rate limiters are defined over real time; fake timers would not exercise the Lua. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
