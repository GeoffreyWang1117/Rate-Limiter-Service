import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import config from '../config';
import logger from '../utils/logger';

/**
 * API-key auth for the control plane.
 *
 * The control plane can raise any tenant's limits to anything, so an
 * unauthenticated one is not a rate limiter that lacks a feature -- it is a rate
 * limiter that anyone who can reach it can turn off. The data plane
 * (reserve/commit/release) is deliberately left open: it is called by internal
 * services on every request, and belongs behind network policy and mTLS at the
 * mesh rather than behind a shared secret in a header.
 */

/**
 * Constant-time comparison. A byte-by-byte early return leaks the position of
 * the first mismatch through response timing, which turns a search over the
 * whole key space into a search one byte at a time.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself be a signal.
  // Comparing a fixed-length digest of each would hide length too; here the
  // length check is folded into the result and both branches still run the
  // comparison against a same-length buffer.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function requireControlPlaneKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const expected = config.auth.controlPlaneKey;

  if (!expected) {
    // Refusing outright in production is the safe failure: a deployment that
    // forgot the key gets a loud 503 rather than a quietly open control plane.
    if (config.server.env === 'production') {
      logger.error('Control plane reached with no CONTROL_PLANE_API_KEY configured');
      res.status(503).json({
        error: {
          code: 'CONTROL_PLANE_UNCONFIGURED',
          message: 'Control plane authentication is not configured on this deployment',
        },
      });
      return;
    }
    next();
    return;
  }

  const header = req.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key');

  if (!provided || !secretsMatch(provided, expected)) {
    logger.warn('Rejected control plane request', { path: req.path, ip: req.ip });
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Valid control plane credentials required' },
    });
    return;
  }

  next();
}
