/**
 * Database Schema Definitions
 * SQL migration scripts for PostgreSQL
 */

export const CREATE_TABLES_SQL = `
-- Rate Limit Rules Table
CREATE TABLE IF NOT EXISTS rate_limit_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  algorithm VARCHAR(50) NOT NULL CHECK (algorithm IN ('token_bucket', 'sliding_window', 'fixed_window', 'leaky_bucket')),
  limit_value INTEGER NOT NULL CHECK (limit_value > 0),
  window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
  dimension_type VARCHAR(50) NOT NULL CHECK (dimension_type IN ('user', 'ip', 'endpoint', 'global', 'custom')),
  dimension_pattern VARCHAR(500),
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT true,
  tags TEXT[],
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Indexes
  CONSTRAINT unique_name UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rate_limit_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_rules_priority ON rate_limit_rules(priority DESC);
CREATE INDEX IF NOT EXISTS idx_rules_dimension_type ON rate_limit_rules(dimension_type);
CREATE INDEX IF NOT EXISTS idx_rules_created_at ON rate_limit_rules(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rules_tags ON rate_limit_rules USING GIN(tags);

-- Rule Hit Statistics Table (optional, for analytics)
CREATE TABLE IF NOT EXISTS rule_hit_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES rate_limit_rules(id) ON DELETE CASCADE,
  hit_count BIGINT NOT NULL DEFAULT 0,
  blocked_count BIGINT NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMP WITH TIME ZONE,
  period_start TIMESTAMP WITH TIME ZONE NOT NULL,
  period_end TIMESTAMP WITH TIME ZONE NOT NULL,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stats_rule_id ON rule_hit_stats(rule_id);
CREATE INDEX IF NOT EXISTS idx_stats_period ON rule_hit_stats(period_start, period_end);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for rate_limit_rules table
DROP TRIGGER IF EXISTS update_rate_limit_rules_updated_at ON rate_limit_rules;
CREATE TRIGGER update_rate_limit_rules_updated_at
  BEFORE UPDATE ON rate_limit_rules
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Trigger for rule_hit_stats table
DROP TRIGGER IF EXISTS update_rule_hit_stats_updated_at ON rule_hit_stats;
CREATE TRIGGER update_rule_hit_stats_updated_at
  BEFORE UPDATE ON rule_hit_stats
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- LLM Admission Policies
--
-- Patterns rather than exact keys, so a deployment expresses "everyone gets
-- this, except these tenants" without a row per (tenant, model) pair. The
-- resolver walks them by priority and takes the first match.
CREATE TABLE IF NOT EXISTS llm_admission_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_pattern VARCHAR(255) NOT NULL,
  model_pattern VARCHAR(255) NOT NULL,

  -- The budget that actually binds for LLM traffic. Requests-per-minute alone
  -- cannot distinguish a 200-token completion from a 200k-token one.
  tokens_per_minute BIGINT NOT NULL CHECK (tokens_per_minute > 0),
  requests_per_minute INTEGER NOT NULL CHECK (requests_per_minute > 0),

  -- Concurrency is a property of the serving backend (GPU slots), not of the
  -- rate budget: a tenant can be well inside its TPM and still have to wait.
  max_concurrency INTEGER NOT NULL DEFAULT 16 CHECK (max_concurrency > 0),
  max_queue_depth INTEGER NOT NULL DEFAULT 64 CHECK (max_queue_depth >= 0),

  -- How long a reservation is held before it is treated as abandoned.
  lease_seconds INTEGER NOT NULL DEFAULT 120 CHECK (lease_seconds > 0),

  reservation_mode VARCHAR(20) NOT NULL DEFAULT 'worst_case'
    CHECK (reservation_mode IN ('worst_case', 'adaptive')),
  reservation_safety_factor NUMERIC(4,2) NOT NULL DEFAULT 1.50
    CHECK (reservation_safety_factor >= 1),

  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT unique_policy_scope UNIQUE (tenant_pattern, model_pattern)
);

-- The resolver's only query: enabled rows, highest priority first.
CREATE INDEX IF NOT EXISTS idx_policies_lookup
  ON llm_admission_policies(priority DESC, created_at ASC)
  WHERE enabled = true;

DROP TRIGGER IF EXISTS update_llm_admission_policies_updated_at ON llm_admission_policies;
CREATE TRIGGER update_llm_admission_policies_updated_at
  BEFORE UPDATE ON llm_admission_policies
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- A catch-all so a fresh deployment has a defined limit rather than an implicit one.
INSERT INTO llm_admission_policies
  (tenant_pattern, model_pattern, tokens_per_minute, requests_per_minute,
   max_concurrency, max_queue_depth, priority)
VALUES ('*', '*', 100000, 600, 16, 64, 1)
ON CONFLICT (tenant_pattern, model_pattern) DO NOTHING;

-- Insert some default rules
INSERT INTO rate_limit_rules (name, description, algorithm, limit_value, window_seconds, dimension_type, priority, enabled)
VALUES
  ('Global Default', 'Default global rate limit', 'token_bucket', 1000, 60, 'global', 999, true),
  ('User Default', 'Default per-user rate limit', 'token_bucket', 100, 60, 'user', 500, true),
  ('IP Default', 'Default per-IP rate limit', 'token_bucket', 200, 60, 'ip', 500, true)
ON CONFLICT (name) DO NOTHING;
`;

export const DROP_TABLES_SQL = `
DROP TRIGGER IF EXISTS update_llm_admission_policies_updated_at ON llm_admission_policies;
DROP TABLE IF EXISTS llm_admission_policies;
DROP TRIGGER IF EXISTS update_rule_hit_stats_updated_at ON rule_hit_stats;
DROP TRIGGER IF EXISTS update_rate_limit_rules_updated_at ON rate_limit_rules;
DROP FUNCTION IF EXISTS update_updated_at_column();
DROP TABLE IF EXISTS rule_hit_stats;
DROP TABLE IF EXISTS rate_limit_rules;
`;
