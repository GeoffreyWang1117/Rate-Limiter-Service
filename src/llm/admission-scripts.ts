/**
 * Atomic admission protocol.
 *
 * Reserve, commit and expiry all mutate the same budget. Splitting them across
 * round trips would let two gateway replicas both see enough budget for a large
 * prompt, or let an expiry sweep refund a reservation at the same moment its
 * owner commits it -- crediting the tenant twice. Each phase is therefore a
 * single script, and Redis runs scripts to completion.
 *
 * Reclaiming expired leases happens inside the admission path rather than in a
 * background sweeper. A sweeper is one more process to deploy, monitor and
 * elect a leader for, and it reclaims budget on its own schedule instead of at
 * the moment someone needs it. Doing a bounded sweep on the path that cares
 * costs a few extra Lua operations and needs no coordination at all.
 */

/**
 * KEYS  1 tpm balance | 2 tpm timestamp | 3 rpm balance | 4 rpm timestamp
 *       5 leases (zset: reservationId -> expiry ms) | 6 reservations (hash: id -> tokens held)
 *       7 stats (hash: ewma service ms, ewma output tokens)
 *
 * ARGV  1 now(ms) 2 tpmLimit 3 tpmRefill/s 4 rpmLimit 5 rpmRefill/s 6 reserveTokens
 *       7 reservationId 8 leaseMs 9 maxConcurrency 10 maxQueueDepth 11 sloTtftMs(0=none)
 *       12 ttl(s) 13 reclaimBatch 14 defaultServiceMs
 *
 * Returns {admitted, reason, reservedTokens, tokensRemaining, requestsRemaining,
 *          inflight, predictedWaitMs, retryAfterMs, reclaimed}
 */
export const ADMIT_SCRIPT = `
local tpm_key, tpm_ts_key   = KEYS[1], KEYS[2]
local rpm_key, rpm_ts_key   = KEYS[3], KEYS[4]
local leases_key, res_key   = KEYS[5], KEYS[6]
local stats_key             = KEYS[7]

local now             = tonumber(ARGV[1])
local tpm_limit       = tonumber(ARGV[2])
local tpm_rate        = tonumber(ARGV[3])
local rpm_limit       = tonumber(ARGV[4])
local rpm_rate        = tonumber(ARGV[5])
local reserve         = tonumber(ARGV[6])
local rid             = ARGV[7]
local lease_ms        = tonumber(ARGV[8])
local max_concurrency = tonumber(ARGV[9])
local max_queue       = tonumber(ARGV[10])
local slo_ttft_ms     = tonumber(ARGV[11])
local ttl             = tonumber(ARGV[12])
local reclaim_batch   = tonumber(ARGV[13])
local default_svc_ms  = tonumber(ARGV[14])

-- Phase 1: reclaim leases whose owner never came back.
-- Bounded per call so a large backlog degrades latency gradually instead of
-- stalling one unlucky request behind thousands of deletions.
local reclaimed_tokens = 0
local reclaimed_count  = 0
local expired = redis.call('ZRANGEBYSCORE', leases_key, '-inf', now, 'LIMIT', 0, reclaim_batch)
for i = 1, #expired do
  local held = tonumber(redis.call('HGET', res_key, expired[i]))
  if held then
    reclaimed_tokens = reclaimed_tokens + held
    redis.call('HDEL', res_key, expired[i])
  end
  redis.call('ZREM', leases_key, expired[i])
  reclaimed_count = reclaimed_count + 1
end

-- Phase 2: refill both budgets. Fractional, and the clock advances whatever the
-- decision turns out to be, so the effective rate does not depend on how often
-- requests are admitted.
local function refill(bal_key, ts_key, capacity, rate)
  local bal = tonumber(redis.call('GET', bal_key))
  local ts  = tonumber(redis.call('GET', ts_key))
  if bal == nil or ts == nil then return capacity end
  return math.min(bal + (math.max(0, now - ts) / 1000) * rate, capacity)
end

local tpm_bal = math.min(refill(tpm_key, tpm_ts_key, tpm_limit, tpm_rate) + reclaimed_tokens, tpm_limit)
local rpm_bal = refill(rpm_key, rpm_ts_key, rpm_limit, rpm_rate)

local inflight = redis.call('ZCARD', leases_key)
local avg_svc  = tonumber(redis.call('HGET', stats_key, 'svc_ms')) or default_svc_ms

-- A request only waits once every GPU slot is busy. Past that it waits for as
-- many batches as there are requests ahead of it.
local predicted_wait = 0
if inflight >= max_concurrency then
  predicted_wait = math.ceil(((inflight + 1 - max_concurrency) / max_concurrency) * avg_svc)
end

local admitted, reason, retry_after_ms = 0, '', 0

if reserve > tpm_limit then
  -- Larger than the tenant's entire per-minute budget. No amount of waiting fixes this.
  reason = 'unsatisfiable'
elseif rpm_bal < 1 then
  reason = 'rpm_exhausted'
  retry_after_ms = math.ceil(((1 - rpm_bal) / rpm_rate) * 1000)
elseif tpm_bal < reserve then
  reason = 'tpm_exhausted'
  retry_after_ms = math.ceil(((reserve - tpm_bal) / tpm_rate) * 1000)
elseif inflight >= max_concurrency + max_queue then
  reason = 'queue_full'
  retry_after_ms = math.ceil(avg_svc)
elseif slo_ttft_ms > 0 and predicted_wait > slo_ttft_ms then
  -- Shed rather than queue. A request admitted into a wait it cannot survive
  -- still holds a slot for the whole wait, so admitting it costs capacity and
  -- delivers nothing.
  reason = 'slo_infeasible'
  retry_after_ms = math.ceil(avg_svc)
else
  admitted = 1
  tpm_bal = tpm_bal - reserve
  rpm_bal = rpm_bal - 1
  redis.call('ZADD', leases_key, now + lease_ms, rid)
  redis.call('HSET', res_key, rid, reserve)
  inflight = inflight + 1
end

-- Balances are persisted on both paths: the refill and the reclaim above are
-- real state changes even when this particular request is turned away.
redis.call('SET', tpm_key, tostring(tpm_bal), 'EX', ttl)
redis.call('SET', tpm_ts_key, tostring(now), 'EX', ttl)
redis.call('SET', rpm_key, tostring(rpm_bal), 'EX', ttl)
redis.call('SET', rpm_ts_key, tostring(now), 'EX', ttl)
redis.call('EXPIRE', leases_key, ttl)
redis.call('EXPIRE', res_key, ttl)

return {
  admitted, reason, reserve,
  math.floor(tpm_bal), math.floor(rpm_bal),
  inflight, predicted_wait, retry_after_ms, reclaimed_count
}
`;

/**
 * KEYS  1 tpm balance | 2 tpm timestamp | 3 leases | 4 reservations | 5 stats
 *       6 settled marker for THIS reservation
 * ARGV  1 now(ms) 2 reservationId 3 actualTokens 4 tpmLimit 5 ttl(s)
 *       6 serviceMs(0=unknown) 7 outputTokens 8 ewmaAlpha 9 idempotencyTtl(s)
 *
 * Returns {status, refundedTokens, tokensRemaining, inflight}
 *   status 1 = committed
 *          2 = reconciled after the lease had already expired
 *          3 = duplicate, ignored
 *
 * Commit is idempotent. It is an ordinary network call made by a client that has
 * just finished a slow generation, which is exactly when timeouts and retries
 * happen; charging twice for one completion is a billing bug that only appears
 * under the conditions hardest to reproduce.
 *
 * The record of a settled reservation is one key per reservation with its own
 * TTL, not a field in a per-tenant hash. A hash field cannot expire on its own,
 * so that version grew with throughput for the whole life of the hash -- a
 * benchmark at 3k commits/s accumulated 218k fields in a single tenant's ledger,
 * and the rehashing showed up as multi-second tail latency on admission. The TTL
 * only has to cover a client's retry horizon, which is far shorter than a lease.
 */
export const COMMIT_SCRIPT = `
local tpm_key, tpm_ts_key = KEYS[1], KEYS[2]
local leases_key, res_key = KEYS[3], KEYS[4]
local stats_key           = KEYS[5]
local settled_key         = KEYS[6]   -- unique to this reservation

local now           = tonumber(ARGV[1])
local rid           = ARGV[2]
local actual        = tonumber(ARGV[3])
local tpm_limit     = tonumber(ARGV[4])
local ttl           = tonumber(ARGV[5])
local service_ms    = tonumber(ARGV[6])
local output_tokens = tonumber(ARGV[7])
local alpha         = tonumber(ARGV[8])
local idem_ttl      = tonumber(ARGV[9])

-- Replay of a commit already applied. Report the balance as it stands and
-- change nothing.
local settled_refund = tonumber(redis.call('GET', settled_key))
if settled_refund then
  local current = tonumber(redis.call('GET', tpm_key)) or tpm_limit
  return {3, math.floor(settled_refund), math.floor(current), redis.call('ZCARD', leases_key)}
end

local held = tonumber(redis.call('HGET', res_key, rid))
local status = 1
if held == nil then
  -- The lease expired and admission already refunded the hold. The work still
  -- happened, so charge what it actually used; skipping it would make an
  -- expired lease a way to get free tokens.
  held = 0
  status = 2
else
  redis.call('HDEL', res_key, rid)
  redis.call('ZREM', leases_key, rid)
end

local bal = tonumber(redis.call('GET', tpm_key))
local ts  = tonumber(redis.call('GET', tpm_ts_key))
if bal == nil or ts == nil then bal = tpm_limit end

-- Negative when the caller generated more than it declared. The balance is
-- allowed to go below zero: the overrun is real consumption and the tenant
-- refills out of the hole before being admitted again.
local refund = held - actual
bal = math.min(bal + refund, tpm_limit)

redis.call('SET', tpm_key, tostring(bal), 'EX', ttl)
redis.call('SET', tpm_ts_key, tostring(now), 'EX', ttl)
redis.call('SET', settled_key, tostring(refund), 'EX', idem_ttl)

-- Keep the wait predictor and the output-length estimator calibrated on real
-- completions. Both are exponentially weighted, so they track drift in traffic
-- mix without storing history.
if service_ms > 0 then
  local prev = tonumber(redis.call('HGET', stats_key, 'svc_ms'))
  local next_val = service_ms
  if prev then next_val = alpha * service_ms + (1 - alpha) * prev end
  redis.call('HSET', stats_key, 'svc_ms', tostring(next_val))
end
if output_tokens > 0 then
  local prev = tonumber(redis.call('HGET', stats_key, 'out_tokens'))
  local next_val = output_tokens
  if prev then next_val = alpha * output_tokens + (1 - alpha) * prev end
  redis.call('HSET', stats_key, 'out_tokens', tostring(next_val))
  local peak = tonumber(redis.call('HGET', stats_key, 'out_peak')) or 0
  if output_tokens > peak then redis.call('HSET', stats_key, 'out_peak', tostring(output_tokens)) end
end
redis.call('EXPIRE', stats_key, ttl)

return {status, math.floor(refund), math.floor(bal), redis.call('ZCARD', leases_key)}
`;

/**
 * Returns a snapshot without mutating budgets, for /stats and dashboards.
 *
 * KEYS  1 tpm balance | 2 tpm timestamp | 3 rpm balance | 4 rpm timestamp | 5 leases | 6 stats
 * ARGV  1 now(ms) 2 tpmLimit 3 tpmRefill/s 4 rpmLimit 5 rpmRefill/s 6 defaultServiceMs
 */
export const SNAPSHOT_SCRIPT = `
local now = tonumber(ARGV[1])
local function refill(bal_key, ts_key, capacity, rate)
  local bal = tonumber(redis.call('GET', bal_key))
  local ts  = tonumber(redis.call('GET', ts_key))
  if bal == nil or ts == nil then return capacity end
  return math.min(bal + (math.max(0, now - ts) / 1000) * rate, capacity)
end
local tpm = refill(KEYS[1], KEYS[2], tonumber(ARGV[2]), tonumber(ARGV[3]))
local rpm = refill(KEYS[3], KEYS[4], tonumber(ARGV[4]), tonumber(ARGV[5]))
local inflight = redis.call('ZCARD', KEYS[5])
local expired  = redis.call('ZCOUNT', KEYS[5], '-inf', now)
local svc = tonumber(redis.call('HGET', KEYS[6], 'svc_ms')) or tonumber(ARGV[6])
local out = tonumber(redis.call('HGET', KEYS[6], 'out_tokens')) or 0
local peak = tonumber(redis.call('HGET', KEYS[6], 'out_peak')) or 0
return {math.floor(tpm), math.floor(rpm), inflight, expired, math.floor(svc), math.floor(out), math.floor(peak)}
`;
