import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { requestLogger } from './middleware/request-logger';
import { errorHandler } from './middleware/error-handler';
import rateLimitRoutes from './routes/rate-limit.routes';
import rulesRoutes from './routes/rules.routes';
import admissionRoutes from './routes/admission.routes';
import healthRoutes from './routes/health.routes';
import metricsRoutes from './routes/metrics.routes';
import logger from './utils/logger';

export function createApp(): Application {
  const app = express();

  // Security middleware
  app.use(helmet());
  app.use(
    cors({
      // No wildcard default. This service has an unauthenticated data plane --
      // reserve and commit are meant to be called by a gateway inside the trust
      // boundary, not by a browser -- and `*` invited any page on the internet
      // to spend a tenant's budget with a guessed tenant name. Unset now means
      // no cross-origin access rather than all of it.
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
        : false,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
    })
  );

  // Before body parsing, deliberately. A malformed body makes express.json()
  // throw, and with the logger registered after it the listener that records
  // the response was never attached -- so every malformed request was invisible
  // in the request counter. The 4xx rate on a dashboard silently excluded an
  // entire class of client error.
  app.use(requestLogger);

  // 10mb was the previous limit, on endpoints whose largest legitimate body is
  // a policy object of a few hundred bytes. JSON parsing happens on the thread
  // that serves every other request, so an unauthenticated caller could spend
  // the event loop on megabytes of parsing -- an odd hole to leave in a service
  // whose purpose is bounding what callers can consume.
  const BODY_LIMIT = process.env.MAX_BODY_SIZE ?? '64kb';
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

  app.use(compression());

  // API Routes
  app.use('/api/v1', rateLimitRoutes);
  app.use('/api/v1/rules', rulesRoutes);
  app.use('/api/v1/llm', admissionRoutes);
  app.use('/health', healthRoutes);
  app.use('/metrics', metricsRoutes);

  // Root endpoint
  app.get('/', (_req, res) => {
    res.json({
      service: 'Rate Limiter Service',
      version: '2.0.0',
      status: 'running',
      endpoints: {
        llmReserve: 'POST /api/v1/llm/reserve',
        llmCommit: 'POST /api/v1/llm/commit',
        llmRelease: 'POST /api/v1/llm/release',
        llmState: 'GET /api/v1/llm/state?tenant=&model=',
        llmPolicies: '/api/v1/llm/policies',
        rateLimit: 'POST /api/v1/check-rate-limit',
        reset: 'POST /api/v1/reset',
        stats: 'POST /api/v1/stats',
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
