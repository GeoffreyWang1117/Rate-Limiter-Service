import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import admissionService from '../llm/admission.service';
import policyResolver from '../llm/policy.resolver';
import policyRepository from '../llm/policy.repository';
import { validateRequest } from '../middleware/validate-request';
import { ShedReason } from '../llm/types';
import { NotFoundError } from '../utils/errors';
import { guardState } from '../middleware/degraded-mode';
import { requireControlPlaneKey } from '../middleware/auth';

const router = Router();

/**
 * Admission defaults to failing closed. Behind this gate is a fixed pool of
 * accelerators: admitting unmetered traffic during a Redis outage does not
 * degrade gracefully, it queues until the backend collapses. Refusing is
 * recoverable; overrunning a GPU fleet is not.
 */
const guarded = guardState('admission', () => ({
  decision: 'shed',
  reason: 'limiter_unavailable',
}));

const identifier = Joi.string().min(1).max(128).required();

const reserveSchema = Joi.object({
  tenant: identifier,
  model: identifier,
  promptTokens: Joi.number().integer().min(0).max(10_000_000).required(),
  maxOutputTokens: Joi.number().integer().min(1).max(10_000_000).required(),
  sloTtftMs: Joi.number().integer().min(1).max(600_000).optional(),
});

const commitSchema = Joi.object({
  tenant: identifier,
  model: identifier,
  reservationId: Joi.string().uuid().required(),
  promptTokens: Joi.number().integer().min(0).max(10_000_000).required(),
  outputTokens: Joi.number().integer().min(0).max(10_000_000).required(),
  serviceMs: Joi.number().integer().min(0).max(3_600_000).optional(),
});

const releaseSchema = Joi.object({
  tenant: identifier,
  model: identifier,
  reservationId: Joi.string().uuid().required(),
});

const policySchema = Joi.object({
  tenantPattern: Joi.string().min(1).max(255).required(),
  modelPattern: Joi.string().min(1).max(255).required(),
  tokensPerMinute: Joi.number().integer().min(1).optional(),
  requestsPerMinute: Joi.number().integer().min(1).optional(),
  maxConcurrency: Joi.number().integer().min(1).max(100_000).optional(),
  maxQueueDepth: Joi.number().integer().min(0).max(1_000_000).optional(),
  leaseSeconds: Joi.number().integer().min(1).max(3_600).optional(),
  reservationMode: Joi.string().valid('worst_case', 'adaptive').optional(),
  reservationSafetyFactor: Joi.number().min(1).max(10).optional(),
  priority: Joi.number().integer().optional(),
  enabled: Joi.boolean().optional(),
});

/**
 * Each shed reason gets the status code that tells the caller the right thing to
 * do, rather than collapsing everything into 429.
 *
 *   429  a budget refills on a known schedule; Retry-After says when
 *   503  the backend is saturated; this is a server-capacity problem, and a
 *        proxy or client library should treat it as one
 *   400  the request can never fit, so retrying is the wrong response entirely
 */
const STATUS_BY_REASON: Record<ShedReason, number> = {
  tpm_exhausted: 429,
  rpm_exhausted: 429,
  queue_full: 503,
  slo_infeasible: 503,
  unsatisfiable: 400,
};

/**
 * POST /api/v1/llm/reserve
 *
 * Phase 1 of the admission protocol. Holds budget for a request whose output
 * length is not yet known. An admitted caller MUST follow up with commit or
 * release; if it does not, the lease expires and the hold is reclaimed.
 */
router.post(
  '/reserve',
  validateRequest(reserveSchema),
  guarded(async (req: Request, res: Response) => {
      const { tenant, model } = req.body;
      const policy = await policyResolver.resolve(tenant, model);

      if (!policy.enabled) {
        res.status(200).json({ decision: 'admit', reason: 'policy_disabled' });
        return;
      }

      const result = await admissionService.reserve(req.body, policy);

      res.set({
        'X-RateLimit-Tokens-Remaining': String(result.tokensRemaining),
        'X-RateLimit-Requests-Remaining': String(result.requestsRemaining),
        'X-Admission-Inflight': String(result.inflight),
      });
      if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));

      const status =
        result.decision === 'admit' ? 200 : STATUS_BY_REASON[result.reason!] ?? 429;
      res.status(status).json(result);
  })
);

/**
 * POST /api/v1/llm/commit
 *
 * Phase 2. Reconciles the hold against what generation actually consumed.
 * Idempotent: a retry after a network timeout is acknowledged without charging
 * the tenant again.
 */
router.post(
  '/commit',
  validateRequest(commitSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policy = await policyResolver.resolve(req.body.tenant, req.body.model);
      res.status(200).json(await admissionService.commit(req.body, policy));
    } catch (error) {
      // Commit is never failed open: losing it silently would leave the hold in
      // place until its lease expires, which is exactly the budget leak the
      // lease mechanism exists to bound. The caller must see the failure and retry.
      next(error);
    }
  }
);

/**
 * POST /api/v1/llm/release
 *
 * Abandons a reservation that produced nothing -- client disconnect, upstream
 * failure. Equivalent to committing zero usage, but explicit at the call site.
 */
router.post(
  '/release',
  validateRequest(releaseSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenant, model, reservationId } = req.body;
      const policy = await policyResolver.resolve(tenant, model);
      res
        .status(200)
        .json(await admissionService.release(tenant, model, reservationId, policy));
    } catch (error) {
      next(error);
    }
  }
);

/** GET /api/v1/llm/state?tenant=&model= -- live budget without consuming any. */
router.get('/state', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenant = String(req.query.tenant ?? '');
    const model = String(req.query.model ?? '');
    if (!tenant || !model) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'tenant and model are required' },
      });
      return;
    }
    const policy = await policyResolver.resolve(tenant, model);
    res.json(await admissionService.snapshot(tenant, model, policy));
  } catch (error) {
    next(error);
  }
});

// --- Control plane ---------------------------------------------------------
// Policy writes invalidate the resolver cache immediately, so an operator
// tightening a limit during an incident sees it take effect now rather than
// after the TTL.
//
// Everything below this line changes what the limits *are*, so it is gated. The
// data plane above is not: it is on the path of every inference and is protected
// at the network layer instead.
router.use('/policies', requireControlPlaneKey);

router.get('/policies', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await policyRepository.findAll() });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/policies',
  validateRequest(policySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policy = await policyRepository.create(req.body);
      policyResolver.invalidate();
      res.status(201).json({ data: policy });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/policies/:id',
  validateRequest(policySchema.fork(['tenantPattern', 'modelPattern'], (s) => s.optional())),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policy = await policyRepository.update(req.params.id, req.body);
      if (!policy) throw new NotFoundError(`No policy with id ${req.params.id}`);
      policyResolver.invalidate();
      res.json({ data: policy });
    } catch (error) {
      next(error);
    }
  }
);

router.delete('/policies/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await policyRepository.delete(req.params.id);
    if (!deleted) throw new NotFoundError(`No policy with id ${req.params.id}`);
    policyResolver.invalidate();
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get('/policies/cache', (_req: Request, res: Response) => {
  res.json({ data: policyResolver.stats() });
});

export default router;
