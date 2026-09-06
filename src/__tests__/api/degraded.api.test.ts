import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../app';
import redisService from '../../services/redis.service';
import postgresService from '../../services/postgres.service';
import policyResolver from '../../llm/policy.resolver';
import policyRepository from '../../llm/policy.repository';
import config from '../../config';
import { RedisConnectionError } from '../../utils/errors';
import { connectRedis, disconnectRedis, flush } from '../support/redis';

/**
 * What the service does when it cannot reach the state it needs.
 *
 * A limiter that answers 500 during a Redis blip has quietly made itself a hard
 * dependency of every service behind it. The two defensible answers are to pass
 * traffic through unmetered or to refuse it, and which one is right depends on
 * what is downstream -- so both are configured, and both say so in the response.
 *
 * Redis is stubbed out rather than actually stopped: killing the shared dev
 * instance mid-suite would take every other test with it, and the failure mode
 * under test is "client cannot reach Redis", which the stub reproduces exactly.
 */
let app: Application;
const TENANT = 'degraded-test-tenant';

beforeAll(async () => {
  await connectRedis();
  await postgresService.connect();
  app = createApp();
  await postgresService.query(
    'DELETE FROM llm_admission_policies WHERE tenant_pattern = $1',
    [TENANT]
  );
  await policyRepository.create({
    tenantPattern: TENANT,
    modelPattern: '*',
    tokensPerMinute: 100_000,
    requestsPerMinute: 10_000,
    priority: 7_100,
  });
  policyResolver.invalidate();
  // Warm the policy cache while Redis is still reachable, so the stub below
  // isolates the data path rather than tripping over policy loading.
  await request(app)
    .post('/api/v1/llm/reserve')
    .send({ tenant: TENANT, model: 'm', promptTokens: 1, maxOutputTokens: 1 });
});

afterAll(async () => {
  await postgresService
    .query('DELETE FROM llm_admission_policies WHERE tenant_pattern = $1', [TENANT])
    .catch(() => undefined);
  await disconnectRedis();
  await postgresService.disconnect();
});

let stub: jest.SpyInstance;

function makeRedisUnreachable(): void {
  stub = jest.spyOn(redisService, 'getClient').mockImplementation(() => {
    throw new RedisConnectionError('Redis client not connected');
  });
}

afterEach(async () => {
  stub?.mockRestore();
  config.failure.rateLimit = 'fail_open';
  config.failure.admission = 'fail_closed';
  if (!stub || !stub.mock) return;
});

beforeEach(flush);

describe('the generic limiter when Redis is unreachable', () => {
  it('fails open by default, and marks the response as unenforced', async () => {
    config.failure.rateLimit = 'fail_open';
    makeRedisUnreachable();

    const res = await request(app)
      .post('/api/v1/check-rate-limit')
      .send({
        key: 'k',
        identifier: 'i',
        algorithm: 'token_bucket',
        limit: 10,
        windowSeconds: 60,
      })
      .expect(200);

    expect(res.body.allowed).toBe(true);
    // The caller has to be able to tell an enforced verdict from a fallback.
    // Returning a bare `allowed: true` is how a limiter looks healthy while
    // enforcing nothing.
    expect(res.body.degraded).toBe('fail_open');
    expect(res.headers['x-ratelimit-degraded']).toBe('fail_open');
  });

  it('refuses traffic instead when configured to fail closed', async () => {
    config.failure.rateLimit = 'fail_closed';
    makeRedisUnreachable();

    const res = await request(app)
      .post('/api/v1/check-rate-limit')
      .send({
        key: 'k',
        identifier: 'i',
        algorithm: 'token_bucket',
        limit: 10,
        windowSeconds: 60,
      })
      .expect(503);

    expect(res.body.error.code).toBe('LIMITER_UNAVAILABLE');
    expect(res.body.degraded).toBe('fail_closed');
  });
});

describe('LLM admission when Redis is unreachable', () => {
  /**
   * Admission defaults the other way. Behind it is a fixed pool of accelerators:
   * letting unmetered traffic through does not degrade gracefully, it queues
   * until the backend collapses. Refusing is recoverable.
   */
  it('sheds by default rather than admitting traffic it cannot account for', async () => {
    config.failure.admission = 'fail_closed';
    makeRedisUnreachable();

    const res = await request(app)
      .post('/api/v1/llm/reserve')
      .send({ tenant: TENANT, model: 'm', promptTokens: 100, maxOutputTokens: 100 })
      .expect(503);

    expect(res.body.degraded).toBe('fail_closed');
  });

  it('can be configured to admit instead, for a deployment that prefers it', async () => {
    config.failure.admission = 'fail_open';
    makeRedisUnreachable();

    const res = await request(app)
      .post('/api/v1/llm/reserve')
      .send({ tenant: TENANT, model: 'm', promptTokens: 100, maxOutputTokens: 100 })
      .expect(200);

    expect(res.body.decision).toBe('shed');
    expect(res.body.degraded).toBe('fail_open');
  });

  /**
   * Commit is never failed open. Dropping it would leave the hold in place until
   * its lease expires -- exactly the budget leak leases exist to bound -- so the
   * caller has to see the error and retry.
   */
  it('propagates a commit failure rather than silently dropping the reconciliation', async () => {
    makeRedisUnreachable();

    await request(app)
      .post('/api/v1/llm/commit')
      .send({
        tenant: TENANT,
        model: 'm',
        reservationId: '00000000-0000-4000-8000-000000000000',
        promptTokens: 10,
        outputTokens: 10,
      })
      .expect(503);
  });
});

describe('health reporting during an outage', () => {
  it('reports unhealthy and fails readiness so traffic is routed elsewhere', async () => {
    jest.spyOn(redisService, 'healthCheck').mockResolvedValue(false);

    await request(app)
      .get('/health')
      .expect(503)
      .expect((res) => expect(res.body.checks.redis).toBe('down'));
    await request(app).get('/health/ready').expect(503);

    // Liveness stays up: restarting healthy replicas in the middle of a
    // dependency outage makes the outage worse.
    await request(app).get('/health/live').expect(200);

    jest.restoreAllMocks();
  });
});
