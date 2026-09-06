import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../app';
import postgresService from '../../services/postgres.service';
import metricsService from '../../services/metrics.service';
import { connectRedis, disconnectRedis } from '../support/redis';

/**
 * How the service reports failures that are not its own.
 *
 * Both properties here were found by curling the running gateway rather than by
 * a test, and both are the kind that never fail loudly: a client's bad request
 * counted as a server fault, and a metric label taken from the request URL.
 */
let app: Application;

beforeAll(async () => {
  await connectRedis();
  await postgresService.connect();
  app = createApp();
});

afterAll(async () => {
  await disconnectRedis();
  await postgresService.disconnect();
});

describe('malformed input is the client\'s error, not the server\'s', () => {
  it('answers 400 for a body that is not JSON', async () => {
    // This used to fall through to the generic handler and return 500. A caller
    // cannot act on "an unexpected error occurred", and whoever watches the 5xx
    // rate sees the service failing when it is behaving correctly.
    const res = await request(app)
      .post('/api/v1/llm/reserve')
      .set('Content-Type', 'application/json')
      .send('{not json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not echo internals in the 400', async () => {
    const res = await request(app)
      .post('/api/v1/llm/reserve')
      .set('Content-Type', 'application/json')
      .send('{not json');

    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts:|node_modules|SyntaxError/);
  });

  it('answers 404 without disclosing the route table', async () => {
    const res = await request(app).get('/no-such-route');

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/\/api\/v1\/llm\/policies|stack/i);
  });
});

describe('metric labels cannot be driven by the caller', () => {
  it('does not mint a time series per requested URL', async () => {
    // Prometheus labels are a cross product, so a label taken from req.path
    // means anyone who can reach the service can grow the registry without
    // limit. The error path was doing exactly that, and it is the part of the
    // service a stranger reaches most easily.
    const before = await metricsService.getMetrics();
    const seriesBefore = before.split('\n').filter((l) => l.includes('api_requests_total')).length;

    for (let i = 0; i < 25; i++) {
      await request(app).get(`/definitely-not-a-route/${i}-${Math.random()}`);
    }

    const after = await metricsService.getMetrics();
    const lines = after.split('\n').filter((l) => l.includes('api_requests_total'));

    expect(lines.length - seriesBefore).toBeLessThanOrEqual(2);
    expect(after).not.toMatch(/definitely-not-a-route\/\d/);
  });

  it('counts an errored request once, not once per handler that saw it', async () => {
    const count = async (): Promise<number> => {
      const text = await metricsService.getMetrics();
      return text
        .split('\n')
        .filter((l) => l.startsWith('rate_limiter_api_requests_total') && l.includes('400'))
        .reduce((sum, l) => sum + Number(l.trim().split(/\s+/).pop() ?? 0), 0);
    };

    const before = await count();
    await request(app)
      .post('/api/v1/llm/reserve')
      .set('Content-Type', 'application/json')
      .send('{not json');
    const after = await count();

    // The error handler used to record alongside the request logger, so every
    // error was counted twice and the rate reported double what happened.
    expect(after - before).toBe(1);
  });
});
