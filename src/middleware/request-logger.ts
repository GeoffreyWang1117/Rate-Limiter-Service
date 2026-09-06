import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import metricsService from '../services/metrics.service';

/**
 * Anything slower than this is worth a line on its own, whatever it returned.
 * Set well above the p99 this service targets, so it fires on genuine outliers
 * rather than on ordinary tail latency.
 */
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_LOG_MS ?? 250);

/**
 * Per-request observability.
 *
 * This used to write a structured info line for every request. Measured at 1,500
 * admission cycles/s, that cost roughly a fifth of a core and pushed p99 from
 * 55ms to 6.9s -- the JSON serialisation and the write both land on the same
 * thread that serves requests, so the logger competes directly with the work it
 * is describing.
 *
 * On a data path at this frequency, per-request facts belong in metrics: a
 * histogram answers "what is p99 by route" without emitting anything per
 * request. Logs are kept for what metrics cannot express -- which specific
 * request failed, and which specific request was pathologically slow.
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    // Cardinality note: req.route?.path is the template ('/policies/:id'), not
    // the filled-in URL. Labelling with req.path would mint a new time series
    // per id and eventually take Prometheus down with it.
    // `??` alone is not enough: an unmatched request has req.route undefined and
    // req.baseUrl set to the empty string, which is not nullish, so every 404
    // was labelled path="" instead of path="unmatched".
    const route = req.route?.path || req.baseUrl || 'unmatched';
    metricsService.recordApiRequest(req.method, route, res.statusCode);
    metricsService.recordApiLatency(req.method, route, durationMs / 1000);

    if (res.statusCode >= 500) {
      logger.error('Request failed', {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs),
      });
      return;
    }

    if (durationMs >= SLOW_REQUEST_MS) {
      logger.warn('Slow request', {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs),
      });
      return;
    }

    // Full access logging stays available for debugging a specific incident;
    // it is simply not on by default at info.
    logger.debug('Request', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs),
    });
  });

  next();
};
