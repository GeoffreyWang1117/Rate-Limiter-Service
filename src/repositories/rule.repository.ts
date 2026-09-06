import { randomUUID } from 'node:crypto';
import postgresService from '../services/postgres.service';
import {
  RateLimitRule,
  CreateRuleRequest,
  UpdateRuleRequest,
  DimensionType,
  RateLimitAlgorithm,
} from '../types';
import logger from '../utils/logger';

/**
 * A row of rate_limit_rules as the driver returns it.
 *
 * Previously every query was `query<any>` and rows were mapped through
 * `mapRowToRule(row: any)`, so a column rename or a type change anywhere in the
 * schema type-checked cleanly and failed at runtime. Naming the shape once means
 * the compiler checks the mapping against it.
 */
interface RuleRow {
  id: string;
  name: string;
  description: string | null;
  algorithm: string;
  limit_value: number;
  window_seconds: number;
  dimension_type: string;
  dimension_pattern: string | null;
  priority: number;
  enabled: boolean;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/**
 * Rule Repository
 * Handles all database operations for rate limit rules
 */
class RuleRepository {
  /**
   * Create a new rate limit rule
   */
  async create(request: CreateRuleRequest): Promise<RateLimitRule> {
    const id = randomUUID();

    const query = `
      INSERT INTO rate_limit_rules (
        id, name, description, algorithm, limit_value, window_seconds,
        dimension_type, dimension_pattern, priority, enabled, tags
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;

    const values = [
      id,
      request.name,
      request.description || null,
      request.algorithm,
      request.limit,
      request.windowSeconds,
      request.dimensionType,
      request.dimensionPattern || null,
      request.priority || 100,
      request.enabled !== undefined ? request.enabled : true,
      request.tags || [],
    ];

    try {
      const result = await postgresService.query<RuleRow>(query, values);
      const rule = this.mapRowToRule(result.rows[0]);

      logger.info('Rule created', { ruleId: rule.id, ruleName: rule.name });
      return rule;
    } catch (error) {
      logger.error('Failed to create rule:', error);
      throw error;
    }
  }

  /**
   * Find rule by ID
   */
  async findById(id: string): Promise<RateLimitRule | null> {
    const query = 'SELECT * FROM rate_limit_rules WHERE id = $1';

    try {
      const result = await postgresService.query<RuleRow>(query, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToRule(result.rows[0]);
    } catch (error) {
      logger.error('Failed to find rule by ID:', error);
      throw error;
    }
  }

  /**
   * Find rule by name
   */
  async findByName(name: string): Promise<RateLimitRule | null> {
    const query = 'SELECT * FROM rate_limit_rules WHERE name = $1';

    try {
      const result = await postgresService.query<RuleRow>(query, [name]);

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToRule(result.rows[0]);
    } catch (error) {
      logger.error('Failed to find rule by name:', error);
      throw error;
    }
  }

  /**
   * Find all rules (with optional filters)
   */
  async findAll(options?: {
    enabled?: boolean;
    dimensionType?: DimensionType;
    limit?: number;
    offset?: number;
  }): Promise<RateLimitRule[]> {
    let query = 'SELECT * FROM rate_limit_rules WHERE 1=1';
    const values: unknown[] = [];
    let paramIndex = 1;

    if (options?.enabled !== undefined) {
      query += ` AND enabled = $${paramIndex++}`;
      values.push(options.enabled);
    }

    if (options?.dimensionType) {
      query += ` AND dimension_type = $${paramIndex++}`;
      values.push(options.dimensionType);
    }

    query += ' ORDER BY priority DESC, created_at DESC';

    if (options?.limit) {
      query += ` LIMIT $${paramIndex++}`;
      values.push(options.limit);
    }

    if (options?.offset) {
      query += ` OFFSET $${paramIndex++}`;
      values.push(options.offset);
    }

    try {
      const result = await postgresService.query<RuleRow>(query, values);
      return result.rows.map((row) => this.mapRowToRule(row));
    } catch (error) {
      logger.error('Failed to find all rules:', error);
      throw error;
    }
  }

  /**
   * Find enabled rules ordered by priority
   */
  async findEnabledRulesByPriority(): Promise<RateLimitRule[]> {
    const query = `
      SELECT * FROM rate_limit_rules
      WHERE enabled = true
      ORDER BY priority DESC, created_at DESC
    `;

    try {
      const result = await postgresService.query<RuleRow>(query);
      return result.rows.map((row) => this.mapRowToRule(row));
    } catch (error) {
      logger.error('Failed to find enabled rules:', error);
      throw error;
    }
  }

  /**
   * Update a rule
   */
  async update(id: string, request: UpdateRuleRequest): Promise<RateLimitRule | null> {
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (request.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(request.name);
    }

    if (request.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(request.description);
    }

    if (request.algorithm !== undefined) {
      updates.push(`algorithm = $${paramIndex++}`);
      values.push(request.algorithm);
    }

    if (request.limit !== undefined) {
      updates.push(`limit_value = $${paramIndex++}`);
      values.push(request.limit);
    }

    if (request.windowSeconds !== undefined) {
      updates.push(`window_seconds = $${paramIndex++}`);
      values.push(request.windowSeconds);
    }

    if (request.dimensionType !== undefined) {
      updates.push(`dimension_type = $${paramIndex++}`);
      values.push(request.dimensionType);
    }

    if (request.dimensionPattern !== undefined) {
      updates.push(`dimension_pattern = $${paramIndex++}`);
      values.push(request.dimensionPattern);
    }

    if (request.priority !== undefined) {
      updates.push(`priority = $${paramIndex++}`);
      values.push(request.priority);
    }

    if (request.enabled !== undefined) {
      updates.push(`enabled = $${paramIndex++}`);
      values.push(request.enabled);
    }

    if (request.tags !== undefined) {
      updates.push(`tags = $${paramIndex++}`);
      values.push(request.tags);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    values.push(id);

    const query = `
      UPDATE rate_limit_rules
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    try {
      const result = await postgresService.query<RuleRow>(query, values);

      if (result.rows.length === 0) {
        return null;
      }

      const rule = this.mapRowToRule(result.rows[0]);
      logger.info('Rule updated', { ruleId: rule.id, ruleName: rule.name });
      return rule;
    } catch (error) {
      logger.error('Failed to update rule:', error);
      throw error;
    }
  }

  /**
   * Delete a rule
   */
  async delete(id: string): Promise<boolean> {
    const query = 'DELETE FROM rate_limit_rules WHERE id = $1';

    try {
      const result = await postgresService.query(query, [id]);
      const deleted = (result.rowCount || 0) > 0;

      if (deleted) {
        logger.info('Rule deleted', { ruleId: id });
      }

      return deleted;
    } catch (error) {
      logger.error('Failed to delete rule:', error);
      throw error;
    }
  }

  /**
   * Enable/Disable a rule
   */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const query = 'UPDATE rate_limit_rules SET enabled = $1 WHERE id = $2';

    try {
      const result = await postgresService.query(query, [enabled, id]);
      const updated = (result.rowCount || 0) > 0;

      if (updated) {
        logger.info('Rule enabled status updated', { ruleId: id, enabled });
      }

      return updated;
    } catch (error) {
      logger.error('Failed to update rule enabled status:', error);
      throw error;
    }
  }

  /**
   * Count total rules
   */
  async count(options?: { enabled?: boolean }): Promise<number> {
    let query = 'SELECT COUNT(*) as count FROM rate_limit_rules';
    const values: unknown[] = [];

    if (options?.enabled !== undefined) {
      query += ' WHERE enabled = $1';
      values.push(options.enabled);
    }

    try {
      const result = await postgresService.query<{ count: string }>(query, values);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error('Failed to count rules:', error);
      throw error;
    }
  }

  /**
   * Map database row to RateLimitRule
   */
  private mapRowToRule(row: RuleRow): RateLimitRule {
    return {
      id: row.id,
      name: row.name,
      algorithm: row.algorithm as RateLimitAlgorithm,
      limit: row.limit_value,
      windowSeconds: row.window_seconds,
      dimension: {
        type: row.dimension_type as DimensionType,
        pattern: row.dimension_pattern ?? undefined,
      },
      priority: row.priority,
      enabled: row.enabled,
      metadata: {
        description: row.description,
        tags: row.tags || [],
        ...(row.metadata || {}),
      },
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export default new RuleRepository();
