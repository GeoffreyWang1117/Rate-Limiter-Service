import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../app';
import postgresService from '../../services/postgres.service';
import policyResolver from '../../llm/policy.resolver';
import ruleEngineService from '../../services/rule-engine.service';
import { connectRedis, disconnectRedis } from '../support/redis';

/**
 * CRUD over both control planes, and the cache invalidation that has to follow
 * a write.
 *
 * The invalidation is the part worth testing. Both planes cache their config for
 * tens of seconds to keep Postgres off the decision path; if a write does not
 * clear that cache, an operator tightening a limit during an incident watches
 * the old limit stay in force with nothing to indicate why.
 */
let app: Application;
const POLICY_TENANT = 'cp-test-tenant';
const RULE_NAME = 'cp-test-rule';

beforeAll(async () => {
  await connectRedis();
  await postgresService.connect();
  app = createApp();
});

afterAll(async () => {
  await cleanup();
  await disconnectRedis();
  await postgresService.disconnect();
});

async function cleanup(): Promise<void> {
  await postgresService
    .query('DELETE FROM llm_admission_policies WHERE tenant_pattern = $1', [POLICY_TENANT])
    .catch(() => undefined);
  await postgresService
    .query('DELETE FROM rate_limit_rules WHERE name LIKE $1', [`${RULE_NAME}%`])
    .catch(() => undefined);
}

beforeEach(cleanup);

describe('admission policy CRUD', () => {
  const policy = {
    tenantPattern: POLICY_TENANT,
    modelPattern: 'gpt-*',
    tokensPerMinute: 50_000,
    requestsPerMinute: 500,
    maxConcurrency: 8,
    reservationMode: 'adaptive' as const,
    priority: 700,
  };

  it('creates, reads, updates and deletes', async () => {
    const created = await request(app)
      .post('/api/v1/llm/policies')
      .send(policy)
      .expect(201);

    const id = created.body.data.id;
    expect(created.body.data.tokensPerMinute).toBe(50_000);
    // BIGINT comes back from the driver as a string. Coercing at the repository
    // boundary is what keeps arithmetic downstream from becoming concatenation.
    expect(typeof created.body.data.tokensPerMinute).toBe('number');

    const listed = await request(app).get('/api/v1/llm/policies').expect(200);
    expect(listed.body.data.some((p: { id: string }) => p.id === id)).toBe(true);

    await request(app)
      .put(`/api/v1/llm/policies/${id}`)
      .send({ tokensPerMinute: 75_000 })
      .expect(200)
      .expect((res) => expect(res.body.data.tokensPerMinute).toBe(75_000));

    await request(app).delete(`/api/v1/llm/policies/${id}`).expect(204);
    await request(app)
      .put(`/api/v1/llm/policies/${id}`)
      .send({ tokensPerMinute: 1 })
      .expect(404);
  });

  it('rejects a policy whose numbers are out of range', async () => {
    await request(app)
      .post('/api/v1/llm/policies')
      .send({ ...policy, maxConcurrency: 0 })
      .expect(400);
    await request(app)
      .post('/api/v1/llm/policies')
      .send({ ...policy, reservationMode: 'wishful' })
      .expect(400);
  });

  /**
   * An updated limit has to be in force on the next decision, not after the
   * resolver's 30s TTL expires. Note what this does *not* assert: raising the
   * limit does not hand the tenant the new headroom instantly. The bucket
   * refills toward the larger capacity at the new rate, which is the point of a
   * token bucket -- an instant jump would let one policy edit release a burst
   * the size of the entire new budget.
   */
  it('puts an updated limit in force on the next decision', async () => {
    const created = await request(app)
      .post('/api/v1/llm/policies')
      .send({ ...policy, modelPattern: '*', tokensPerMinute: 10_000, priority: 7_200 })
      .expect(201);

    const before = await request(app)
      .get('/api/v1/llm/state')
      .query({ tenant: POLICY_TENANT, model: 'any' })
      .expect(200);
    expect(before.body.policy.tokensPerMinute).toBe(10_000);

    await request(app)
      .put(`/api/v1/llm/policies/${created.body.data.id}`)
      .send({ tokensPerMinute: 900_000 })
      .expect(200);

    const after = await request(app)
      .get('/api/v1/llm/state')
      .query({ tenant: POLICY_TENANT, model: 'any' })
      .expect(200);

    // Would still read 10,000 if the write had not invalidated the resolver cache.
    expect(after.body.policy.tokensPerMinute).toBe(900_000);
  });

  it('reports resolver cache state for operators', async () => {
    policyResolver.invalidate();
    const res = await request(app).get('/api/v1/llm/policies/cache').expect(200);
    expect(res.body.data).toHaveProperty('policies');
    expect(res.body.data).toHaveProperty('stale');
  });
});

describe('rate limit rule CRUD', () => {
  const rule = {
    name: RULE_NAME,
    description: 'created by the control plane test',
    algorithm: 'token_bucket',
    limit: 42,
    windowSeconds: 60,
    dimensionType: 'user',
    dimensionPattern: 'cp-*',
    priority: 640,
    enabled: true,
  };

  it('creates, reads, updates, toggles and deletes', async () => {
    const created = await request(app).post('/api/v1/rules').send(rule).expect(201);
    const id = created.body.data.id;

    await request(app)
      .get(`/api/v1/rules/${id}`)
      .expect(200)
      .expect((res) => expect(res.body.data.limit).toBe(42));

    await request(app)
      .put(`/api/v1/rules/${id}`)
      .send({ limit: 84 })
      .expect(200)
      .expect((res) => expect(res.body.data.limit).toBe(84));

    await request(app).post(`/api/v1/rules/${id}/disable`).expect(200);
    await request(app)
      .get(`/api/v1/rules/${id}`)
      .expect((res) => expect(res.body.data.enabled).toBe(false));

    await request(app).post(`/api/v1/rules/${id}/enable`).expect(200);
    await request(app).delete(`/api/v1/rules/${id}`).expect(200);
    await request(app).get(`/api/v1/rules/${id}`).expect(404);
  });

  it('rejects a duplicate rule name', async () => {
    await request(app).post('/api/v1/rules').send(rule).expect(201);
    await request(app).post('/api/v1/rules').send(rule).expect(409);
  });

  it('exposes and invalidates the rule cache', async () => {
    ruleEngineService.invalidateCache();
    await request(app)
      .get('/api/v1/rules/cache/stats')
      .expect(200)
      .expect((res) => expect(res.body.data).toHaveProperty('cachedRules'));

    await request(app).post('/api/v1/rules/cache/invalidate').expect(200);
  });
});
