import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { requestLogger } from './middleware/request-logger';
import { errorHandler } from './middleware/error-handler';
import rateLimitRoutes from './routes/rate-limit.routes';
import rulesRoutes from './routes/rules.routes';
import healthRoutes from './routes/health.routes';
import metricsRoutes from './routes/metrics.routes';
import logger from './utils/logger';

export function createApp(): Application {
  const app = express();

  // Security middleware
  app.use(helmet());
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
    })
  );

  // Body parsing middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Compression
  app.use(compression());

  // Request logging
  app.use(requestLogger);

  // API Routes
  app.use('/api/v1', rateLimitRoutes);
  app.use('/api/v1/rules', rulesRoutes);
  app.use('/health', healthRoutes);
  app.use('/metrics', metricsRoutes);

  // Root endpoint
  app.get('/', (_req, res) => {
    res.json({
      service: 'Rate Limiter Service',
      version: '2.0.0',
      status: 'running',
      endpoints: {
        rateLimit: '/api/v1/check-rate-limit',
        reset: '/api/v1/reset',
        stats: '/api/v1/stats',
        rules: '/api/v1/rules',
        health: '/health',
        metrics: '/metrics',
      },
    });
  });

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found',
      },
    });
  });

  // Error handling middleware (must be last)
  app.use(errorHandler);

  logger.info('Express app configured');

  return app;
}
