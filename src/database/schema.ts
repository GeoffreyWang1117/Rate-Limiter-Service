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

-- Insert some default rules
INSERT INTO rate_limit_rules (name, description, algorithm, limit_value, window_seconds, dimension_type, priority, enabled)
VALUES
  ('Global Default', 'Default global rate limit', 'token_bucket', 1000, 60, 'global', 999, true),
  ('User Default', 'Default per-user rate limit', 'token_bucket', 100, 60, 'user', 500, true),
  ('IP Default', 'Default per-IP rate limit', 'token_bucket', 200, 60, 'ip', 500, true)
ON CONFLICT (name) DO NOTHING;
`;

export const DROP_TABLES_SQL = `
DROP TRIGGER IF EXISTS update_rule_hit_stats_updated_at ON rule_hit_stats;
DROP TRIGGER IF EXISTS update_rate_limit_rules_updated_at ON rate_limit_rules;
DROP FUNCTION IF EXISTS update_updated_at_column();
DROP TABLE IF EXISTS rule_hit_stats;
DROP TABLE IF EXISTS rate_limit_rules;
`;
