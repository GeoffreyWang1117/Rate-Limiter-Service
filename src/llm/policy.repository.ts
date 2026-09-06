import postgresService from '../services/postgres.service';
import logger from '../utils/logger';
import { AdmissionPolicy, DEFAULT_POLICY, ReservationMode } from './types';

/**
 * Shapes as the driver returns them, not as we wish they were.
 *
 * node-postgres hands back BIGINT and NUMERIC as strings, because they can hold
 * values outside the range JS numbers represent exactly. Typing them as `number`
 * makes the compiler agree with an assumption that is false at runtime -- the
 * value then works everywhere it is coerced (`"5000" / 60`) and breaks silently
 * everywhere it is not (`"5000" + 1` is `"50001"`).
 */
interface PolicyRow {
  id: string;
  tenant_pattern: string;
  model_pattern: string;
  tokens_per_minute: string;
  requests_per_minute: number;
  max_concurrency: number;
  max_queue_depth: number;
  lease_seconds: number;
  reservation_mode: ReservationMode;
  reservation_safety_factor: string;
  priority: number;
  enabled: boolean;
}

export interface StoredPolicy extends AdmissionPolicy {
  id: string;
  tenantPattern: string;
  modelPattern: string;
  priority: number;
}

function toPolicy(row: PolicyRow): StoredPolicy {
  return {
    id: row.id,
    tenantPattern: row.tenant_pattern,
    modelPattern: row.model_pattern,
    tenant: row.tenant_pattern,
    model: row.model_pattern,
    tokensPerMinute: Number(row.tokens_per_minute),
    requestsPerMinute: row.requests_per_minute,
    maxConcurrency: row.max_concurrency,
    maxQueueDepth: row.max_queue_depth,
    leaseSeconds: row.lease_seconds,
    reservationMode: row.reservation_mode,
    reservationSafetyFactor: Number(row.reservation_safety_factor),
    priority: row.priority,
    enabled: row.enabled,
  };
}

export interface CreatePolicyInput {
  tenantPattern: string;
  modelPattern: string;
  tokensPerMinute?: number;
  requestsPerMinute?: number;
  maxConcurrency?: number;
  maxQueueDepth?: number;
  leaseSeconds?: number;
  reservationMode?: ReservationMode;
  reservationSafetyFactor?: number;
  priority?: number;
  enabled?: boolean;
}

/** Request-field name to column name. Doubles as the allowlist for UPDATE. */
const COLUMN: Record<keyof CreatePolicyInput, string> = {
  tenantPattern: 'tenant_pattern',
  modelPattern: 'model_pattern',
  tokensPerMinute: 'tokens_per_minute',
  requestsPerMinute: 'requests_per_minute',
  maxConcurrency: 'max_concurrency',
  maxQueueDepth: 'max_queue_depth',
  leaseSeconds: 'lease_seconds',
  reservationMode: 'reservation_mode',
  reservationSafetyFactor: 'reservation_safety_factor',
  priority: 'priority',
  enabled: 'enabled',
};

class PolicyRepository {
  async findAll(): Promise<StoredPolicy[]> {
    const { rows } = await postgresService.query<PolicyRow>(
      `SELECT * FROM llm_admission_policies ORDER BY priority DESC, created_at ASC`
    );
    return rows.map(toPolicy);
  }

  async findEnabledByPriority(): Promise<StoredPolicy[]> {
    const { rows } = await postgresService.query<PolicyRow>(
      `SELECT * FROM llm_admission_policies
       WHERE enabled = true
       ORDER BY priority DESC, created_at ASC`
    );
    return rows.map(toPolicy);
  }

  async findById(id: string): Promise<StoredPolicy | null> {
    const { rows } = await postgresService.query<PolicyRow>(
      `SELECT * FROM llm_admission_policies WHERE id = $1`,
      [id]
    );
    return rows[0] ? toPolicy(rows[0]) : null;
  }

  async create(input: CreatePolicyInput): Promise<StoredPolicy> {
    const { rows } = await postgresService.query<PolicyRow>(
      `INSERT INTO llm_admission_policies
         (tenant_pattern, model_pattern, tokens_per_minute, requests_per_minute,
          max_concurrency, max_queue_depth, lease_seconds, reservation_mode,
          reservation_safety_factor, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.tenantPattern,
        input.modelPattern,
        input.tokensPerMinute ?? DEFAULT_POLICY.tokensPerMinute,
        input.requestsPerMinute ?? DEFAULT_POLICY.requestsPerMinute,
        input.maxConcurrency ?? DEFAULT_POLICY.maxConcurrency,
        input.maxQueueDepth ?? DEFAULT_POLICY.maxQueueDepth,
        input.leaseSeconds ?? DEFAULT_POLICY.leaseSeconds,
        input.reservationMode ?? DEFAULT_POLICY.reservationMode,
        input.reservationSafetyFactor ?? DEFAULT_POLICY.reservationSafetyFactor,
        input.priority ?? 100,
        input.enabled ?? true,
      ]
    );
    logger.info('Admission policy created', {
      id: rows[0].id,
      tenant: input.tenantPattern,
      model: input.modelPattern,
    });
    return toPolicy(rows[0]);
  }

  async update(
    id: string,
    input: Partial<CreatePolicyInput>
  ): Promise<StoredPolicy | null> {
    const assignments: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      // Column names come from the fixed COLUMN map above, never interpolated
      // from request data. Values are always bound as parameters.
      const col = COLUMN[key as keyof CreatePolicyInput];
      if (!col) continue;
      values.push(value);
      assignments.push(`${col} = $${values.length}`);
    }
    if (assignments.length === 0) return this.findById(id);

    values.push(id);
    const { rows } = await postgresService.query<PolicyRow>(
      `UPDATE llm_admission_policies SET ${assignments.join(', ')}
       WHERE id = $${values.length} RETURNING *`,
      values
    );
    return rows[0] ? toPolicy(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await postgresService.query(
      `DELETE FROM llm_admission_policies WHERE id = $1`,
      [id]
    );
    return (rowCount ?? 0) > 0;
  }
}

export default new PolicyRepository();
