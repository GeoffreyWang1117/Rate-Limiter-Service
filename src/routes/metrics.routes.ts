import { Router, Request, Response } from 'express';
import metricsService from '../services/metrics.service';

const router = Router();

/**
 * GET /metrics
 * Prometheus metrics endpoint
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const metrics = await metricsService.getMetrics();
    res.set('Content-Type', metricsService.getRegistry().contentType);
    res.send(metrics);
  } catch (error) {
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

export default router;
