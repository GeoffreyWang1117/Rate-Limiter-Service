import { Request, Response, NextFunction } from 'express';
import { RateLimiterError, RateLimitExceededError } from '../utils/errors';
import logger from '../utils/logger';

/**
 * Terminal error handling.
 *
 * Three things this deliberately does not do:
 *
 * 1. **It does not record metrics.** `requestLogger` already records every
 *    response from `res.on('finish')`, which fires for error responses too, so
 *    doing it here counted every error twice. Worse, it recorded against
 *    `req.path` -- the filled-in URL -- while the finish handler records the
 *    route template. Prometheus labels are a cross product, so a client
 *    requesting random paths minted an unbounded number of time series from the
 *    error path, which is the easiest place on the service for a stranger to
 *    reach. Cardinality is bounded by having exactly one recording site, and it
 *    is the one that knows the template.
 *
 * 2. **It does not log a stack trace for a client's mistake.** A malformed body
 *    is not a server fault. Logging all of them at error level with a stack let
 *    any caller drive this service's log volume and its error rate, and buried
 *    genuine 5xx in noise.
 *
 * 3. **It does not echo the error message on a 5xx.** Anything unrecognised
 *    could carry a connection string or a query fragment.
 */

/** body-parser signals a malformed body with a SyntaxError carrying the raw body. */
function isMalformedBody(err: Error): boolean {
  return err instanceof SyntaxError && 'body' in err;
}

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  if (err instanceof RateLimiterError) {
    logger.debug('Request rejected', {
      code: err.code,
      status: err.statusCode,
      path: req.path,
      method: req.method,
    });

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        // instanceof rather than a name string: the cast it replaces would
        // happily read `retryAfter` off any error whose name happened to match.
        ...(err instanceof RateLimitExceededError && { retryAfter: err.retryAfter }),
      },
    });
    return;
  }

  if (isMalformedBody(err)) {
    // Used to fall through to the 500 below, so a caller sending `{bad json`
    // was told the server had failed. That is wrong for the caller, who cannot
    // act on it, and wrong for whoever is watching the 5xx rate.
    logger.debug('Malformed request body', { path: req.path, method: req.method });
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON' },
    });
    return;
  }

  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' },
  });
};
