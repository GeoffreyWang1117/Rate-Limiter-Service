import { Router, Request, Response } from 'express';
import redisService from '../services/redis.service';
import config from '../config';

const router = Router();

/**
 * GET /health
 * Health check endpoint
 */
router.get('/', async (_req: Request, res: Response) => {
  const redisHealthy = await redisService.healthCheck();

  const health = {
    status: redisHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    service: 'rate-limiter-service',
    version: '1.0.0',
    checks: {
      redis: redisHealthy ? 'up' : 'down',
    },
  };

  res.status(redisHealthy ? 200 : 503).json(health);
});

/**
 * GET /health/ready
 * Readiness probe for Kubernetes
 */
router.get('/ready', async (_req: Request, res: Response) => {
  const redisHealthy = await redisService.healthCheck();

  if (redisHealthy) {
    res.status(200).json({ ready: true });
  } else {
    res.status(503).json({ ready: false, reason: 'Redis not available' });
  }
});

/**
 * GET /health/live
 * Liveness probe for Kubernetes
 */
router.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ alive: true });
});

export default router;
