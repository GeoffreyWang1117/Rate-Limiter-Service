/**
 * Lua scripts for atomic Redis operations
 */

/**
 * Token Bucket Algorithm - Lua Script
 * Ensures atomic token consumption and refill
 *
 * KEYS[1]: Token count key
 * KEYS[2]: Last refill timestamp key
 * ARGV[1]: Max tokens (capacity)
 * ARGV[2]: Refill rate (tokens per second)
 * ARGV[3]: Current timestamp (milliseconds)
 * ARGV[4]: Tokens requested (usually 1)
 * ARGV[5]: Window seconds (TTL)
 *
 * Returns: {allowed (1/0), remaining tokens, reset timestamp}
 */
export const TOKEN_BUCKET_SCRIPT = `
local tokens_key = KEYS[1]
local timestamp_key = KEYS[2]
local max_tokens = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local tokens_requested = tonumber(ARGV[4])
local window_seconds = tonumber(ARGV[5])

-- Get current state
local current_tokens = tonumber(redis.call('GET', tokens_key) or max_tokens)
local last_refill = tonumber(redis.call('GET', timestamp_key) or now)

-- Calculate tokens to add based on time elapsed
local time_elapsed = (now - last_refill) / 1000
local tokens_to_add = math.floor(time_elapsed * refill_rate)

-- Refill tokens (capped at max_tokens)
current_tokens = math.min(current_tokens + tokens_to_add, max_tokens)

-- Calculate next reset time
local reset_at = now + (window_seconds * 1000)

if current_tokens >= tokens_requested then
  -- Consume tokens
  current_tokens = current_tokens - tokens_requested

  -- Update state
  redis.call('SET', tokens_key, current_tokens, 'EX', window_seconds)
  redis.call('SET', timestamp_key, now, 'EX', window_seconds)

  return {1, current_tokens, reset_at}
else
  -- Not enough tokens
  local time_until_token = math.ceil((tokens_requested - current_tokens) / refill_rate)
  local retry_after = math.max(1, time_until_token)

  return {0, current_tokens, reset_at, retry_after}
end
`;

/**
 * Sliding Window Counter - Lua Script
 * Uses sorted set to track requests within a time window
 *
 * KEYS[1]: Sorted set key
 * ARGV[1]: Current timestamp (milliseconds)
 * ARGV[2]: Window size (milliseconds)
 * ARGV[3]: Max requests allowed
 * ARGV[4]: Request ID (unique identifier)
 * ARGV[5]: Window seconds (for TTL)
 *
 * Returns: {allowed (1/0), current count, reset timestamp}
 */
export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local request_id = ARGV[4]
local window_seconds = tonumber(ARGV[5])

-- Remove old entries outside the window
local window_start = now - window_ms
redis.call('ZREMRANGEBYSCORE', key, 0, window_start)

-- Count current requests in window
local current_count = redis.call('ZCARD', key)

-- Calculate reset time
local reset_at = now + window_ms

if current_count < max_requests then
  -- Add new request
  redis.call('ZADD', key, now, request_id)
  redis.call('EXPIRE', key, window_seconds)

  return {1, current_count + 1, reset_at}
else
  -- Get oldest request timestamp for retry-after calculation
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after = 0
  if #oldest > 0 then
    local oldest_timestamp = tonumber(oldest[2])
    retry_after = math.ceil((oldest_timestamp + window_ms - now) / 1000)
  end

  return {0, current_count, reset_at, retry_after}
end
`;

/**
 * Fixed Window Counter - Lua Script
 * Simple counter with fixed time windows
 *
 * KEYS[1]: Counter key
 * ARGV[1]: Max requests allowed
 * ARGV[2]: Window seconds
 * ARGV[3]: Current timestamp (milliseconds)
 *
 * Returns: {allowed (1/0), current count, reset timestamp, retry_after}
 */
export const FIXED_WINDOW_SCRIPT = `
local key = KEYS[1]
local max_requests = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Get current count
local current = tonumber(redis.call('GET', key) or '0')

-- Calculate reset time (aligned to window boundary)
local current_window = math.floor(now / (window_seconds * 1000))
local reset_at = (current_window + 1) * window_seconds * 1000

if current < max_requests then
  local new_count = redis.call('INCR', key)
  if new_count == 1 then
    redis.call('EXPIRE', key, window_seconds)
  end

  return {1, new_count, reset_at}
else
  local ttl = redis.call('TTL', key)
  local retry_after = math.max(1, ttl)

  return {0, current, reset_at, retry_after}
end
`;

/**
 * Reset rate limit - Lua Script
 * Deletes all keys associated with a rate limit
 *
 * KEYS: Array of keys to delete
 *
 * Returns: Number of keys deleted
 */
export const RESET_SCRIPT = `
local deleted = 0
for i, key in ipairs(KEYS) do
  deleted = deleted + redis.call('DEL', key)
end
return deleted
`;
