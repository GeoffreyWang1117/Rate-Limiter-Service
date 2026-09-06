# API Reference

Base URL in the examples: `http://localhost:3055` (the local dev stack). The
Docker stack serves on `:3000`.

All request and response bodies are JSON.

---

## Data plane — LLM admission

The three-phase protocol. A caller that is admitted **must** follow up with
`commit` or `release`; if it does not, the lease expires and the hold is
reclaimed by the next admission call on that tenant.

### `POST /api/v1/llm/reserve`

Holds budget for a request whose output length is not yet known.

```json
{
  "tenant": "acme",
  "model": "llama-70b",
  "promptTokens": 900,
  "maxOutputTokens": 4096,
  "sloTtftMs": 2000
}
```

| Field | Required | |
|---|---|---|
| `tenant` | yes | Billing/quota subject |
| `model` | yes | Resolved against policy patterns together with `tenant` |
| `promptTokens` | yes | Known exactly, from tokenizing the prompt |
| `maxOutputTokens` | yes | Ceiling the caller commits to. The unknown lives under this |
| `sloTtftMs` | no | Deadline for the first output token. When set, requests predicted to miss it are shed rather than queued |

**200 — admitted**

```json
{
  "decision": "admit",
  "reservationId": "eaafe94d-b62b-4064-8082-625dde7bd2e0",
  "reservedTokens": 1724,
  "leaseExpiresAt": 1788113668397,
  "tokensRemaining": 398276,
  "requestsRemaining": 599,
  "inflight": 3,
  "predictedWaitMs": 0,
  "reclaimed": 0
}
```

`reservedTokens` is what was actually held. Under `worst_case` it equals
`promptTokens + maxOutputTokens`; under `adaptive` it is an estimate. `reclaimed`
counts expired leases swept during this call — sustained non-zero means clients
are dying between reserve and commit.

**429 / 503 / 400 — shed**

```json
{
  "decision": "shed",
  "reason": "tpm_exhausted",
  "tokensRemaining": 9,
  "requestsRemaining": 98,
  "inflight": 2,
  "predictedWaitMs": 1000,
  "retryAfter": 30,
  "reclaimed": 0
}
```

| `reason` | Status | Retry-After | |
|---|---|---|---|
| `tpm_exhausted` | 429 | yes | Token budget spent |
| `rpm_exhausted` | 429 | yes | Request budget spent |
| `queue_full` | 503 | yes | Concurrency and queue both full |
| `slo_infeasible` | 503 | yes | A slot will free, but not before `sloTtftMs` |
| `unsatisfiable` | 400 | **no** | Larger than the tenant's whole budget; retrying can never work |

**Headers** on every response: `X-RateLimit-Tokens-Remaining`,
`X-RateLimit-Requests-Remaining`, `X-Admission-Inflight`, and `Retry-After` when
one applies.

---

### `POST /api/v1/llm/commit`

Reconciles the hold against what generation actually consumed. **Idempotent** — a
retry after a network timeout is acknowledged without charging again.

```json
{
  "tenant": "acme",
  "model": "llama-70b",
  "reservationId": "eaafe94d-b62b-4064-8082-625dde7bd2e0",
  "promptTokens": 900,
  "outputTokens": 210,
  "serviceMs": 1840
}
```

`serviceMs` is optional but worth sending: it keeps the wait predictor calibrated
on real completions, which is what `slo_infeasible` decisions are made against.

**200**

```json
{
  "status": "committed",
  "refundedTokens": 614,
  "tokensRemaining": 398890,
  "inflight": 2
}
```

| `status` | |
|---|---|
| `committed` | Normal path |
| `reconciled_after_expiry` | The lease had expired and its hold was already refunded. Actual usage is charged now, so work the GPU really did is still paid for |
| `duplicate_ignored` | Already settled. The budget was not touched again |

`refundedTokens` is negative when the caller generated more than it reserved. The
overrun is charged; the balance is allowed below zero and the tenant refills out
of the hole before being admitted again.

Commit is never failed open. If Redis is unreachable it returns 503 and the
caller must retry — dropping it would leave the hold in place until its lease
expires, which is the leak leases exist to bound.

---

### `POST /api/v1/llm/release`

Abandons a reservation that produced nothing — client disconnect, upstream error.
Equivalent to committing zero usage.

```json
{ "tenant": "acme", "model": "llama-70b", "reservationId": "eaafe94d-..." }
```

---

### `GET /api/v1/llm/state?tenant=&model=`

Live budget and in-flight state. Consumes nothing.

```json
{
  "tenant": "acme",
  "model": "llama-70b",
  "tokensRemaining": 398890,
  "requestsRemaining": 597,
  "inflight": 2,
  "expiredLeasesPending": 0,
  "avgServiceMs": 1840,
  "avgOutputTokens": 205,
  "peakOutputTokens": 3980,
  "policy": { "...": "the policy in force for this pair" }
}
```

---

## Control plane — admission policies

Gated by `CONTROL_PLANE_API_KEY`, sent as `Authorization: Bearer <key>` or
`X-API-Key: <key>`.

| Method | Path | |
|---|---|---|
| GET | `/api/v1/llm/policies` | List all |
| POST | `/api/v1/llm/policies` | Create — 201, or 409 on a duplicate scope |
| PUT | `/api/v1/llm/policies/:id` | Update — 200, or 404 |
| DELETE | `/api/v1/llm/policies/:id` | Delete — 204, or 404 |
| GET | `/api/v1/llm/policies/cache` | Resolver cache state |

```json
{
  "tenantPattern": "acme",
  "modelPattern": "premium-*",
  "tokensPerMinute": 500000,
  "requestsPerMinute": 2000,
  "maxConcurrency": 32,
  "maxQueueDepth": 128,
  "leaseSeconds": 120,
  "reservationMode": "adaptive",
  "reservationSafetyFactor": 1.5,
  "priority": 800,
  "enabled": true
}
```

| Field | Default | |
|---|---|---|
| `tenantPattern` / `modelPattern` | — | Exact, glob (`acme-*`, `gpt-?`) or `/regex/`. `*` matches everything |
| `tokensPerMinute` | 100000 | The budget that binds for most LLM workloads |
| `requestsPerMinute` | 600 | Guards against many tiny requests |
| `maxConcurrency` | 16 | In-flight requests the backend can serve — GPU slots |
| `maxQueueDepth` | 64 | Additional requests allowed to wait for a slot |
| `leaseSeconds` | 120 | How long a hold survives without a commit |
| `reservationMode` | `worst_case` | `worst_case` never overruns; `adaptive` recovers stranded budget |
| `reservationSafetyFactor` | 1.5 | Multiplier on the estimate, `adaptive` only |
| `priority` | 100 | Highest match wins; ties go to the older row |

A write invalidates the resolver cache immediately, so an operator tightening a
limit during an incident sees it take effect now rather than after the 30s TTL.
Note that raising a limit does not hand the tenant the new headroom instantly:
the bucket refills toward the larger capacity at the new rate, because an instant
jump would release a burst the size of the entire new budget.

---

## Generic HTTP rate limiting

For non-LLM traffic. Unchanged in shape from before, with the addition that
stored rules now actually reach the decision path.

### `POST /api/v1/check-rate-limit`

```json
{
  "key": "user:12345",
  "identifier": "12345",
  "endpoint": "/api/v1/search",
  "algorithm": "token_bucket",
  "limit": 100,
  "windowSeconds": 60,
  "metadata": { "tier": "premium" }
}
```

`algorithm`, `limit` and `windowSeconds` are optional. Precedence: explicit
request fields, then the highest-priority matching stored rule, then service
defaults. The response says which applied:

```json
{
  "allowed": true,
  "limit": 100,
  "remaining": 99,
  "resetAt": 1788113668397,
  "effective": {
    "algorithm": "token_bucket",
    "limit": 100,
    "windowSeconds": 60,
    "source": "rule",
    "ruleId": "…",
    "ruleName": "premium tier"
  }
}
```

`source` is `request`, `rule` or `default`. The governing rule is also returned
in `X-RateLimit-Policy`, so a 429 in production is attributable to the
configuration that caused it.

429 when blocked, with `Retry-After`.

| Algorithm | | Cost |
|---|---|---|
| `token_bucket` | Admits bursts up to `limit`, then settles to `limit/window` per second. Supports a weighted cost | 2 keys |
| `sliding_window` | Exact, no boundary burst | `limit` sorted-set members per key |
| `fixed_window` | Cheapest; permits up to 2x `limit` across a boundary | 1 integer per key per window |

### `POST /api/v1/reset` · `POST /api/v1/stats`

```json
{ "key": "user:12345", "algorithm": "token_bucket", "windowSeconds": 60 }
```

`windowSeconds` matters for `fixed_window`, whose keys are indexed by window —
without it the wrong window is addressed.

### Rules CRUD

`/api/v1/rules` — `GET`, `POST` (201 / 409), `GET|PUT|DELETE /:id`,
`POST /:id/enable`, `POST /:id/disable`, `GET /cache/stats`,
`POST /cache/invalidate`. Gated by `CONTROL_PLANE_API_KEY`.

Rules match on a dimension: `global`, `user` (against `identifier`), `ip`,
`endpoint`, or `custom` (against `metadata`, as `key=value` or `key~regex`). A
rule scoped to a dimension the request does not carry does not match.

---

## Operational

| Path | |
|---|---|
| `GET /health` | Both dependencies. 503 when Redis is down |
| `GET /health/ready` | Readiness. Fails without Redis |
| `GET /health/live` | Liveness. Checks nothing external, by design |
| `GET /metrics` | Prometheus text format |

## Errors

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…" } }
```

| Code | Status |
|---|---|
| `VALIDATION_ERROR` | 400 |
| `UNAUTHORIZED` | 401 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `RATE_LIMIT_EXCEEDED` | 429 |
| `LIMITER_UNAVAILABLE` | 503 |
| `CONTROL_PLANE_UNCONFIGURED` | 503 |
| `INTERNAL_SERVER_ERROR` | 500 |

Responses served from a configured failure mode carry `"degraded": "fail_open"`
or `"fail_closed"` and an `X-RateLimit-Degraded` header, so a caller can tell an
enforced verdict from a fallback.
