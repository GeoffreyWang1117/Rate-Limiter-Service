/**
 * Lua scripts for atomic Redis operations.
 *
 * Every rate-limit decision must be a single atomic read-modify-write. Doing the
 * refill/compare/deduct in application code would let two concurrent gateway
 * instances both observe "1 token left" and both admit, over-admitting by the
 * number of replicas. Redis executes a script to completion before serving any
 * other command, so the whole decision is serialised on the shard.
 */

/**
 * Token Bucket.
 *
 * KEYS[1] token count (stored as a float)
 * KEYS[2] last-refill timestamp (ms)
 * ARGV[1] capacity
 * ARGV[2] refill rate, tokens per second (fractional)
 * ARGV[3] now (ms)
 * ARGV[4] tokens requested
 * ARGV[5] key TTL (seconds)
 *
 * Returns {allowed, remaining, resetAtMs, retryAfterMs}
 *
 * Two properties this implementation is careful about:
 *
 *  1. Refill is fractional. Accruing `floor(elapsed * rate)` tokens and then
 *     advancing the clock to `now` silently discards every sub-token fraction.
 *     At high request rates the elapsed time between calls is small enough that
 *     the floor is 0 almost every time, so the bucket refills far slower than
 *     configured and rejects traffic that is inside its budget. We keep the
 *     fractional balance in Redis instead.
 *  2. The clock advances on every call, allowed or not, because the balance is
 *     always written back. Advancing it only on the allowed path (or only on the
 *     rejected path) makes the effective rate depend on the accept ratio.
 */
export const TOKEN_BUCKET_SCRIPT = `
local tokens_key    = KEYS[1]
local timestamp_key = KEYS[2]
local capacity      = tonumber(ARGV[1])
local refill_rate   = tonumber(ARGV[2])
local now           = tonumber(ARGV[3])
local requested     = tonumber(ARGV[4])
local ttl           = tonumber(ARGV[5])

local current = tonumber(redis.call('GET', tokens_key))
local last    = tonumber(redis.call('GET', timestamp_key))
if current == nil or last == nil then
  current = capacity
  last    = now
end

local elapsed = math.max(0, now - last) / 1000
current = math.min(current + elapsed * refill_rate, capacity)

local allowed = 0
local retry_after_ms = 0
if current >= requested then
  allowed = 1
  current = current - requested
else
  retry_after_ms = math.ceil(((requested - current) / refill_rate) * 1000)
end

redis.call('SET', tokens_key, tostring(current), 'EX', ttl)
redis.call('SET', timestamp_key, tostring(now), 'EX', ttl)

local reset_at = now + math.ceil(((capacity - current) / refill_rate) * 1000)
return {allowed, math.floor(current), reset_at, retry_after_ms}
`;

/**
 * Sliding Window Log.
 *
 * KEYS[1] sorted set of request timestamps
 * ARGV[1] now (ms)
 * ARGV[2] window size (ms)
 * ARGV[3] max requests in the window
 * ARGV[4] unique member id for this request
 *
 * Returns {allowed, countInWindow, resetAtMs, retryAfterMs}
 *
 * Exact, at the cost of one sorted-set member per admitted request. The member
 * is only added when the request is admitted, so a rejected caller cannot push
 * its own reset time further out by retrying.
 */
export const SLIDING_WINDOW_SCRIPT = `
local key          = KEYS[1]
local now          = tonumber(ARGV[1])
local window_ms    = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local member       = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window_ms)
local count = redis.call('ZCARD', key)

if count < max_requests then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window_ms)
  return {1, count + 1, now + window_ms, 0}
end

-- Capacity frees up when the oldest request in the window ages out.
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry_after_ms = window_ms
if #oldest > 0 then
  retry_after_ms = math.max(0, math.ceil(tonumber(oldest[2]) + window_ms - now))
end
redis.call('PEXPIRE', key, window_ms)
return {0, count, now + retry_after_ms, retry_after_ms}
`;

/**
 * Fixed Window Counter.
 *
 * KEYS[1] counter key, already suffixed with the window index by the caller
 * ARGV[1] max requests
 * ARGV[2] window size (seconds)
 * ARGV[3] now (ms)
 *
 * Returns {allowed, count, resetAtMs, retryAfterMs}
 *
 * The TTL is set to the remaining life of the window rather than a full window,
 * so a key created near a boundary does not linger for most of the next window.
 */
export const FIXED_WINDOW_SCRIPT = `
local key            = KEYS[1]
local max_requests   = tonumber(ARGV[1])
local window_seconds = tonumber(ARGV[2])
local now            = tonumber(ARGV[3])

local window_ms = window_seconds * 1000
local reset_at  = (math.floor(now / window_ms) + 1) * window_ms
local ttl_ms    = reset_at - now

local count = tonumber(redis.call('GET', key) or '0')
if count < max_requests then
  count = redis.call('INCR', key)
  redis.call('PEXPIRE', key, ttl_ms)
  return {1, count, reset_at, 0}
end

redis.call('PEXPIRE', key, ttl_ms)
return {0, count, reset_at, ttl_ms}
`;

/**
 * Deletes every key passed in KEYS. Used by reset(), which always knows the
 * exact key names it needs to drop -- no KEYS/SCAN pattern sweep on the data path.
 */
export const RESET_SCRIPT = `
local deleted = 0
for i, key in ipairs(KEYS) do
  deleted = deleted + redis.call('DEL', key)
end
return deleted
`;
