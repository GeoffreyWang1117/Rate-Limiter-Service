import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import ruleRepository from '../repositories/rule.repository';
import ruleEngineService from '../services/rule-engine.service';
import { validateRequest } from '../middleware/validate-request';
import { RateLimitAlgorithm, DimensionType } from '../types';
import { NotFoundError, ValidationError } from '../utils/errors';
import logger from '../utils/logger';

const router = Router();

// Validation schemas
const createRuleSchema = Joi.object({
  name: Joi.string().required().min(3).max(255),
  description: Joi.string().optional().max(1000),
  algorithm: Joi.string()
    .valid(...Object.values(RateLimitAlgorithm))
    .required(),
  limit: Joi.number().integer().min(1).max(1000000).required(),
  windowSeconds: Joi.number().integer().min(1).max(86400).required(),
  dimensionType: Joi.string()
    .valid(...Object.values(DimensionType))
    .required(),
  dimensionPattern: Joi.string().optional().max(500),
  priority: Joi.number().integer().min(0).max(1000).optional(),
  enabled: Joi.boolean().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
});

const updateRuleSchema = Joi.object({
  name: Joi.string().optional().min(3).max(255),
  description: Joi.string().optional().max(1000),
  algorithm: Joi.string()
    .valid(...Object.values(RateLimitAlgorithm))
    .optional(),
  limit: Joi.number().integer().min(1).max(1000000).optional(),
  windowSeconds: Joi.number().integer().min(1).max(86400).optional(),
  dimensionType: Joi.string()
    .valid(...Object.values(DimensionType))
    .optional(),
  dimensionPattern: Joi.string().optional().max(500),
  priority: Joi.number().integer().min(0).max(1000).optional(),
  enabled: Joi.boolean().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
}).min(1);

/**
 * POST /api/v1/rules
 * Create a new rate limit rule
 */
router.post(
  '/',
  validateRequest(createRuleSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check if rule with same name already exists
      const existing = await ruleRepository.findByName(req.body.name);
      if (existing) {
        throw new ValidationError(`Rule with name '${req.body.name}' already exists`);
      }

      const rule = await ruleRepository.create(req.body);

      // Invalidate cache
      ruleEngineService.invalidateCache();

      res.status(201).json({
        success: true,
        data: rule,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/rules
 * Get all rules (with optional filters)
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { enabled, dimensionType, limit, offset } = req.query;

    const options: any = {};

    if (enabled !== undefined) {
      options.enabled = enabled === 'true';
    }

    if (dimensionType) {
      options.dimensionType = dimensionType as DimensionType;
    }

    if (limit) {
      options.limit = parseInt(limit as string, 10);
    }

    if (offset) {
      options.offset = parseInt(offset as string, 10);
    }

    const rules = await ruleRepository.findAll(options);
    const total = await ruleRepository.count(
      enabled !== undefined ? { enabled: enabled === 'true' } : undefined
    );

    res.json({
      success: true,
      data: rules,
      pagination: {
        total,
        limit: options.limit || total,
        offset: options.offset || 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/rules/:id
 * Get a specific rule by ID
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rule = await ruleRepository.findById(req.params.id);

    if (!rule) {
      throw new NotFoundError(`Rule not found: ${req.params.id}`);
    }

    res.json({
      success: true,
      data: rule,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/rules/:id
 * Update a rule
 */
router.put(
  '/:id',
  validateRequest(updateRuleSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check if name is being updated and conflicts with existing rule
      if (req.body.name) {
        const existing = await ruleRepository.findByName(req.body.name);
        if (existing && existing.id !== req.params.id) {
          throw new ValidationError(`Rule with name '${req.body.name}' already exists`);
        }
      }

      const rule = await ruleRepository.update(req.params.id, req.body);

      if (!rule) {
        throw new NotFoundError(`Rule not found: ${req.params.id}`);
      }

      // Invalidate cache
      ruleEngineService.invalidateCache();

      res.json({
        success: true,
        data: rule,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/rules/:id
 * Delete a rule
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await ruleRepository.delete(req.params.id);

    if (!deleted) {
      throw new NotFoundError(`Rule not found: ${req.params.id}`);
    }

    // Invalidate cache
    ruleEngineService.invalidateCache();

    res.json({
      success: true,
      message: `Rule deleted: ${req.params.id}`,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/rules/:id/enable
 * Enable a rule
 */
router.post(
  '/:id/enable',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await ruleRepository.setEnabled(req.params.id, true);

      if (!updated) {
        throw new NotFoundError(`Rule not found: ${req.params.id}`);
      }

      // Invalidate cache
      ruleEngineService.invalidateCache();

      res.json({
        success: true,
        message: `Rule enabled: ${req.params.id}`,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/rules/:id/disable
 * Disable a rule
 */
router.post(
  '/:id/disable',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await ruleRepository.setEnabled(req.params.id, false);

      if (!updated) {
        throw new NotFoundError(`Rule not found: ${req.params.id}`);
      }

      // Invalidate cache
      ruleEngineService.invalidateCache();

      res.json({
        success: true,
        message: `Rule disabled: ${req.params.id}`,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/rules/cache/stats
 * Get rule cache statistics
 */
router.get('/cache/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = ruleEngineService.getCacheStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/rules/cache/invalidate
 * Manually invalidate rule cache
 */
router.post(
  '/cache/invalidate',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ruleEngineService.invalidateCache();

      res.json({
        success: true,
        message: 'Rule cache invalidated',
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
