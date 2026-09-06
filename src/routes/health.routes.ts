import { Router, Request, Response } from 'express';
import redisService from '../services/redis.service';
import postgresService from '../services/postgres.service';

const router = Router();

const VERSION = process.env.npm_package_version ?? '2.0.0';

/**
 * GET /health -- full dependency report, for humans and for uptime checks.
 */
router.get('/', async (_req: Request, res: Response) => {
  const [redis, postgres] = await Promise.all([
    redisService.healthCheck(),
    postgresService.healthCheck(),
  ]);

  // Redis holds the counters; without it no decision can be made. Postgres only
  // holds policy, and the resolver serves its last known set when the database
  // is away, so a Postgres outage is degraded rather than down.
  const status = redis ? (postgres ? 'healthy' : 'degraded') : 'unhealthy';

  res.status(redis ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    service: 'rate-limiter-service',
    version: VERSION,
    checks: {
      redis: redis ? 'up' : 'down',
      postgres: postgres ? 'up' : 'down',
    },
  });
});

/**
 * GET /health/ready -- readiness. Fails while Redis is unreachable so a load
 * balancer stops sending traffic to a replica that cannot decide anything.
 */
router.get('/ready', async (_req: Request, res: Response) => {
  const redis = await redisService.healthCheck();
  res
    .status(redis ? 200 : 503)
    .json(redis ? { ready: true } : { ready: false, reason: 'redis_unavailable' });
});

/**
 * GET /health/live -- liveness. Deliberately checks nothing external: a
 * liveness probe that fails on a dependency outage makes the orchestrator
 * restart every healthy replica in the middle of that outage.
 */
router.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ alive: true });
});

export default router;
