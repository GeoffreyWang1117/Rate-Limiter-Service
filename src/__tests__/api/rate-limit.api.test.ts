import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../app';
import postgresService from '../../services/postgres.service';
import ruleRepository from '../../repositories/rule.repository';
import ruleEngineService from '../../services/rule-engine.service';
import { RateLimitAlgorithm, DimensionType } from '../../types';
import { connectRedis, disconnectRedis, flush } from '../support/redis';

/**
 * Covers the generic HTTP limiter and, in particular, that stored rules reach
 * the decision path at all.
 *
 * They did not used to. The rule engine was written, persisted to Postgres and
 * exposed over a full CRUD API, but nothing on the check path ever called
 * `findMatchingRule` -- so every configured rule was inert and the service
 * quietly applied its compiled-in defaults to everything. Nothing failed; the
 * rules simply had no effect, which is the hardest kind of bug to notice from
 * the outside.
 */
let app: Application;
const RULE_PREFIX = 'api-test-rule';

beforeAll(async () => {
  await connectRedis();
  await postgresService.connect();
  app = createApp();
});

afterAll(async () => {
  await dropTestRules();
  await disconnectRedis();
  await postgresService.disconnect();
});

async function dropTestRules(): Promise<void> {
  await postgresService.query('DELETE FROM rate_limit_rules WHERE name LIKE $1', [
    `${RULE_PREFIX}%`,
  ]);
}

/**
 * The seeded default rules ship enabled and match everything, so they would
 * govern any request this suite makes. Disabled for the duration, restored after.
 */
async function disableSeededRules(): Promise<void> {
  await postgresService.query(
    'UPDATE rate_limit_rules SET enabled = false WHERE name NOT LIKE $1',
    [`${RULE_PREFIX}%`]
  );
}

beforeEach(async () => {
  await flush();
  await dropTestRules();
  await disableSeededRules();
  ruleEngineService.invalidateCache();
});

afterAll(async () => {
  await postgresService
    .query('UPDATE rate_limit_rules SET enabled = true WHERE name NOT LIKE $1', [
      `${RULE_PREFIX}%`,
    ])
    .catch(() => undefined);
});

const check = (over: Record<string, unknown> = {}) => ({
  key: 'user:api-test',
  identifier: 'api-test',
  ...over,
});

describe('POST /api/v1/check-rate-limit', () => {
  it('uses explicit request parameters when the caller supplies all of them', async () => {
    const res = await request(app)
      .post('/api/v1/check-rate-limit')
      .send(check({ algorithm: 'token_bucket', limit: 5, windowSeconds: 60 }))
      .expect(200);

    expect(res.body.allowed).toBe(true);
    expect(res.body.limit).toBe(5);
    expect(res.body.effective.source).toBe('request');
    expect(res.headers['x-ratelimit-policy']).toBe('request');
  });

  it('applies a stored rule when the caller does not state its own limit', async () => {
    await ruleRepository.create({
      name: `${RULE_PREFIX}-user`,
      algorithm: RateLimitAlgorithm.TOKEN_BUCKET,
      limit: 3,
      windowSeconds: 3600,
      dimensionType: DimensionType.USER,
      dimensionPattern: 'api-test',
      priority: 900,
      enabled: true,
    });
    ruleEngineService.invalidateCache();

    const first = await request(app)
      .post('/api/v1/check-rate-limit')
      .send(check())
      .expect(200);

    expect(first.body.limit).toBe(3);
    expect(first.body.effective.source).toBe('rule');
    expect(first.body.effective.ruleName).toBe(`${RULE_PREFIX}-user`);
    // Traceability: a 429 in production has to be attributable to the rule that
    // produced it.
    expect(first.headers['x-ratelimit-policy']).toBe(`${RULE_PREFIX}-user`);
  });

  it('actually enforces the stored rule, not just reports it', async () => {
    await ruleRepository.create({
      name: `${RULE_PREFIX}-tight`,
      algorithm: RateLimitAlgorithm.TOKEN_BUCKET,
      limit: 2,
      windowSeconds: 3600,
      dimensionType: DimensionType.USER,
      dimensionPattern: 'api-test',
      priority: 900,
      enabled: true,
    });
    ruleEngineService.invalidateCache();

    await request(app).post('/api/v1/check-rate-limit').send(check()).expect(200);
    await request(app).post('/api/v1/check-rate-limit').send(check()).expect(200);

    const blocked = await request(app)
      .post('/api/v1/check-rate-limit')
      .send(check())
      .expect(429);

    expect(blocked.body.allowed).toBe(false);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('prefers the higher-priority rule when several match', async () => {
    await ruleRepository.create({
      name: `${RULE_PREFIX}-broad`,
      algorithm: RateLimitAlgorithm.TOKEN_BUCKET,
      limit: 10,
      windowSeconds: 3600,
      dimensionType: DimensionType.GLOBAL,
      priority: 100,
      enabled: true,
    });
    await ruleRepository.create({
      name: `${RULE_PREFIX}-specific`,
      algorithm: RateLimitAlgorithm.SLIDING_WINDOW,
      limit: 7,
      windowSeconds: 3600,
      dimensionType: DimensionType.USER,
      dimensionPattern: 'api-*',
      priority: 800,
      enabled: true,
    });
    ruleEngineService.invalidateCache();

    const res = await request(app).post('/api/v1/check-rate-limit').send(check()).expect(200);

    expect(res.body.effective.ruleName).toBe(`${RULE_PREFIX}-specific`);
    expect(res.body.limit).toBe(7);
    expect(res.body.effective.algorithm).toBe('sliding_window');
  });

  it('ignores a disabled rule and falls back to the defaults', async () => {
    await ruleRepository.create({
      name: `${RULE_PREFIX}-off`,
      algorithm: RateLimitAlgorithm.TOKEN_BUCKET,
      limit: 1,
      windowSeconds: 3600,
      dimensionType: DimensionType.GLOBAL,
      priority: 900,
      enabled: false,
    });
    ruleEngineService.invalidateCache();

    const res = await request(app).post('/api/v1/check-rate-limit').send(check()).expect(200);
    expect(res.body.effective.source).toBe('default');
  });

  it('lets a caller override one field of a matched rule and inherit the rest', async () => {
    await ruleRepository.create({
      name: `${RULE_PREFIX}-partial`,
      algorithm: RateLimitAlgorithm.SLIDING_WINDOW,
      limit: 50,
      windowSeconds: 3600,
      dimensionType: DimensionType.GLOBAL,
      priority: 900,
      enabled: true,
    });
    ruleEngineService.invalidateCache();

    const res = await request(app)
      .post('/api/v1/check-rate-limit')
      .send(check({ limit: 9 }))
      .expect(200);

    expect(res.body.limit).toBe(9);
    expect(res.body.effective.algorithm).toBe('sliding_window');
    expect(res.body.effective.source).toBe('rule');
  });

  it('validates the request body', async () => {
    await request(app).post('/api/v1/check-rate-limit').send({ key: '' }).expect(400);
  });
});

describe('POST /api/v1/stats and /api/v1/reset', () => {
  it('reports usage and clears it', async () => {
    const params = { algorithm: 'token_bucket', limit: 10, windowSeconds: 60 };
    await request(app).post('/api/v1/check-rate-limit').send(check(params)).expect(200);

    await request(app)
      .post('/api/v1/stats')
      .send({ key: 'user:api-test', algorithm: 'token_bucket' })
      .expect(200)
      .expect((res) => expect(res.body.currentCount).toBe(9));

    await request(app)
      .post('/api/v1/reset')
      .send({ key: 'user:api-test', algorithm: 'token_bucket' })
      .expect(200);

    await request(app)
      .post('/api/v1/stats')
      .send({ key: 'user:api-test', algorithm: 'token_bucket' })
      .expect(404);
  });
});

describe('unknown routes', () => {
  it('returns a structured 404', async () => {
    await request(app)
      .get('/no/such/thing')
      .expect(404)
      .expect((res) => expect(res.body.error.code).toBe('NOT_FOUND'));
  });
});
