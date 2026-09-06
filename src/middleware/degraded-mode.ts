import { Request, Response, NextFunction, RequestHandler } from 'express';
import config from '../config';
import { RedisConnectionError } from '../utils/errors';
import logger from '../utils/logger';
import metricsService from '../services/metrics.service';

type Surface = 'rateLimit' | 'admission';

/**
 * ioredis surfaces an unreachable server as an ordinary Error whose message
 * varies with how the connection died. `getClient()` throws our own typed error
 * only when the client was never connected in the first place, so both shapes
 * have to be recognised.
 */
const CONNECTION_FAILURE = /Connection is closed|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|Stream isn't writeable|max retries/i;

function isStateUnavailable(error: unknown): boolean {
  if (error instanceof RedisConnectionError) return true;
  return error instanceof Error && CONNECTION_FAILURE.test(error.message);
}

/**
 * Decides what a limiter does when it cannot reach the state it needs.
 *
 * A limiter that returns 500 when Redis blips has made itself a hard dependency
 * of everything it fronts: its own availability becomes the ceiling on the
 * availability of the whole fleet. The two honest responses are to let traffic
 * through unmetered or to refuse it, and which is right depends on what sits
 * downstream -- so it is configuration, not a default baked into the code.
 *
 * Either way the response says so. Quietly returning `allowed: true` during an
 * outage is how a limiter comes to look healthy while enforcing nothing.
 */
export function guardState(
  surface: Surface,
  openResponse: (req: Request) => object
) {
  return (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        await handler(req, res);
      } catch (error) {
        if (!isStateUnavailable(error)) {
          next(error);
          return;
        }

        const mode = config.failure[surface];
        metricsService.recordDegraded(surface, mode);
        logger.error('Limiter state unavailable; applying configured failure mode', {
          surface,
          mode,
          path: req.path,
          error: (error as Error).message,
        });

        res.set('X-RateLimit-Degraded', mode);

        if (mode === 'fail_open') {
          res.status(200).json({ ...openResponse(req), degraded: 'fail_open' });
          return;
        }

        res.status(503).json({
          error: {
            code: 'LIMITER_UNAVAILABLE',
            message:
              'Limiter state is unavailable and this surface is configured to fail closed',
          },
          degraded: 'fail_closed',
        });
      }
    };
}
