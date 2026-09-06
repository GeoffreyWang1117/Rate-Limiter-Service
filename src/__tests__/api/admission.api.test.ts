import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../app';
import postgresService from '../../services/postgres.service';
import policyResolver from '../../llm/policy.resolver';
import policyRepository from '../../llm/policy.repository';
import config from '../../config';
import { connectRedis, disconnectRedis, flush } from '../support/redis';

/**
 * Exercises the service through Express, against real Redis and real Postgres.
 *
 * The status code a caller receives is part of the contract -- a client library
 * routes on it -- and so is which surfaces require credentials. Neither is
 * visible from a service-level test.
 */
let app: Application;
const TENANT = 'api-test-tenant';

beforeAll(async () => {
  await connectRedis();
  await postgresService.connect();
  app = createApp();
});

afterAll(async () => {
  await dropTestPolicies();
  await disconnectRedis();
  await postgresService.disconnect();
});

/**
 * Policies are unique on (tenant_pattern, model_pattern), so each case starts
 * from a clean slate rather than colliding with whatever the previous one left
 * behind. Only rows belonging to this suite's tenant are touched.
 */
async function dropTestPolicies(): Promise<void> {
  await postgresService.query(
    'DELETE FROM llm_admission_policies WHERE tenant_pattern = $1',
    [TENANT]
  );
}

beforeEach(async () => {
  await flush();
  await dropTestPolicies();
  policyResolver.invalidate();
});

async function givenPolicy(overrides: Record<string, unknown> = {}): Promise<void> {
  await policyRepository.create({
    tenantPattern: TENANT,
    modelPattern: '*',
    tokensPerMinute: 10_000,
    requestsPerMinute: 1_000,
    maxConcurrency: 100,
    maxQueueDepth: 100,
    leaseSeconds: 60,
    priority: 7_000,
    ...overrides,
  });
  policyResolver.invalidate();
}

const body = (over: Record<string, unknown> = {}) => ({
  tenant: TENANT,
  model: 'api-test-model',
  promptTokens: 500,
  maxOutputTokens: 1_000,
  ...over,
});

describe('POST /api/v1/llm/reserve', () => {
  it('admits and reports the remaining budget in headers', async () => {
    await givenPolicy();

    const res = await request(app).post('/api/v1/llm/reserve').send(body()).expect(200);

    expect(res.body.decision).toBe('admit');
    expect(res.body.reservationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-ratelimit-tokens-remaining']).toBe('8500');
    expect(res.headers['x-admission-inflight']).toBe('1');
  });

  /**
   * Collapsing every rejection into 429 tells a client to retry when retrying is
   * hopeless, and tells a proxy that a saturated backend is a client-side quota
   * problem. Each reason gets the code that implies the right next action.
   */
  it('maps an exhausted token budget to 429 with Retry-After', async () => {
    await givenPolicy({ tokensPerMinute: 1_500 });

    await request(app).post('/api/v1/llm/reserve').send(body()).expect(200);
    const res = await request(app).post('/api/v1/llm/reserve').send(body()).expect(429);

    expect(res.body.reason).toBe('tpm_exhausted');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('maps a saturated backend to 503, not 429', async () => {
    await givenPolicy({ maxConcurrency: 1, maxQueueDepth: 0 });

    await request(app).post('/api/v1/llm/reserve').send(body()).expect(200);
    const res = await request(app).post('/api/v1/llm/reserve').send(body()).expect(503);

    expect(res.body.reason).toBe('queue_full');
  });

  it('maps an impossible request to 400, with no Retry-After to loop on', async () => {
    await givenPolicy({ tokensPerMinute: 100 });

    const res = await request(app)
      .post('/api/v1/llm/reserve')
      .send(body({ promptTokens: 5_000 }))
      .expect(400);

    expect(res.body.reason).toBe('unsatisfiable');
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('rejects a malformed request before it reaches Redis', async () => {
    await givenPolicy();
    await request(app)
      .post('/api/v1/llm/reserve')
      .send({ tenant: TENANT, model: 'm', promptTokens: -1, maxOutputTokens: 10 })
      .expect(400);
  });
});

describe('the reserve/commit round trip', () => {
  it('returns the unused hold and reports it in the live state', async () => {
    await givenPolicy();

    const reserved = await request(app).post('/api/v1/llm/reserve').send(body()).expect(200);

    await request(app)
      .post('/api/v1/llm/commit')
      .send({
        tenant: TENANT,
        model: 'api-test-model',
        reservationId: reserved.body.reservationId,
        promptTokens: 500,
        outputTokens: 60,
        serviceMs: 900,
      })
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('committed');
        expect(res.body.refundedTokens).toBe(940);
      });

    const state = await request(app)
      .get('/api/v1/llm/state')
      .query({ tenant: TENANT, model: 'api-test-model' })
      .expect(200);

    expect(state.body.inflight).toBe(0);
    expect(state.body.avgServiceMs).toBe(900);
    expect(state.body.tokensRemaining).toBeGreaterThanOrEqual(9_440);
  });

  it('requires both tenant and model to read state', async () => {
    await request(app).get('/api/v1/llm/state').query({ tenant: TENANT }).expect(400);
  });
});

describe('policy resolution', () => {
  it('applies the highest-priority pattern that matches', async () => {
    await givenPolicy({ tokensPerMinute: 10_000, priority: 7_000 });
    await givenPolicy({
      tenantPattern: `${TENANT}`,
      modelPattern: 'premium-*',
      tokensPerMinute: 90_000,
      priority: 7_500,
    });

    const standard = await request(app)
      .post('/api/v1/llm/reserve')
      .send(body({ model: 'api-test-model' }))
      .expect(200);
    const premium = await request(app)
      .post('/api/v1/llm/reserve')
      .send(body({ model: 'premium-large' }))
      .expect(200);

    expect(standard.body.tokensRemaining).toBe(8_500);
    expect(premium.body.tokensRemaining).toBe(88_500);
  });
});

describe('control plane authentication', () => {
  const KEY = 'test-control-plane-key';

  // The middleware reads the key at request time, so a case can set it directly
  // on the config object. Re-importing the app with a different environment
  // would build a second module registry whose Redis and Postgres singletons
  // are unconnected, and the resulting 503s would say nothing about auth.
  afterEach(() => {
    config.auth.controlPlaneKey = undefined;
    config.server.env = 'test';
  });

  it('rejects an unauthenticated policy write when a key is configured', async () => {
    config.auth.controlPlaneKey = KEY;
    await request(app)
      .post('/api/v1/llm/policies')
      .send({ tenantPattern: 'x', modelPattern: '*' })
      .expect(401);
  });

  it('rejects a wrong key', async () => {
    config.auth.controlPlaneKey = KEY;
    await request(app)
      .get('/api/v1/llm/policies')
      .set('Authorization', 'Bearer not-the-key')
      .expect(401);
  });

  it('rejects a key of a different length without leaking that through timing', async () => {
    config.auth.controlPlaneKey = KEY;
    await request(app).get('/api/v1/llm/policies').set('x-api-key', 'short').expect(401);
  });

  it('accepts the configured key, as a bearer token or an api-key header', async () => {
    config.auth.controlPlaneKey = KEY;
    await request(app)
      .get('/api/v1/llm/policies')
      .set('Authorization', `Bearer ${KEY}`)
      .expect(200);
    await request(app).get('/api/v1/llm/policies').set('x-api-key', KEY).expect(200);
  });

  it('leaves the data plane open, since it is called on every inference', async () => {
    config.auth.controlPlaneKey = KEY;
    await givenPolicy();
    await request(app).post('/api/v1/llm/reserve').send(body()).expect(200);
  });

  /**
   * An unset key means "open" in development and "closed" in production. A
   * deployment that forgets to configure one should fail loudly rather than
   * quietly accept anonymous writes that can raise any tenant's limits.
   */
  it('closes the control plane in production when no key is configured', async () => {
    config.auth.controlPlaneKey = undefined;
    config.server.env = 'production';
    await request(app).get('/api/v1/llm/policies').expect(503);
  });

  it('leaves it open outside production, for local development', async () => {
    config.auth.controlPlaneKey = undefined;
    config.server.env = 'development';
    await request(app).get('/api/v1/llm/policies').expect(200);
  });
});

describe('operational endpoints', () => {
  it('reports both dependencies in the health check', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.checks).toEqual({ redis: 'up', postgres: 'up' });
  });

  it('keeps liveness independent of dependencies', async () => {
    await request(app).get('/health/live').expect(200, { alive: true });
  });

  it('exposes the admission metrics Prometheus is configured to scrape', async () => {
    await givenPolicy();
    await request(app).post('/api/v1/llm/reserve').send(body());

    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('llm_admission_decisions_total');
    expect(res.text).toContain('llm_tokens_reserved_total');
    expect(res.text).toContain('llm_tokens_worst_case_total');
  });
});
