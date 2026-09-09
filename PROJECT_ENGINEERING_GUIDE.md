# Project Engineering Guide

Technical handoff for `Rate-Limiter-Service` (npm package name: `llm-admission-gateway`).

Written for an engineer with no prior context. Everything here was recovered by
reading the code, configuration, scripts, tests, git history and committed
experiment artifacts, and by probing a running instance. It is not a summary of
`README.md`; where the two disagree, this document states the code's behaviour
and names the discrepancy.

**Audit date:** 2026-09-08
**Branch documented:** `feat/llm-admission-control` @ `252ae91` (repository default)
**Scope:** documentation only. No source, config, test or artifact was modified
to produce this. Defects found are recorded, not fixed.

## Evidence tags

| Tag | Meaning |
|---|---|
| `[CODE]` | Read directly from source; behaviour follows from the code as written |
| `[TEST]` | Asserted by a test in `src/__tests__/` |
| `[GIT]` | Supported by commit history |
| `[ARTIFACT]` | Supported by a committed file under `bench/results/` |
| `[PROBE]` | Confirmed during this audit by driving a running instance |
| `[DOC]` | Claimed by repository documentation only; not independently confirmed |
| `[INFERRED]` | Reasoned from several signals; no single statement establishes it |
| `[UNKNOWN]` | The repository does not contain enough evidence |

---

# 1. Executive overview

## 1.1 Project in one sentence

An HTTP service that decides whether an LLM inference request may proceed, by
holding a token budget across the request's lifetime rather than counting
requests at arrival.

## 1.2 The problem being solved

A conventional API rate limiter charges one unit per request and decides once, at
arrival. Neither half holds for LLM traffic `[CODE: src/llm/types.ts:1-25]`:

- **Cost is tokens, not requests**, and varies by three orders of magnitude
  between a one-line completion and a 200k-token context. A request counter
  reads nearly empty while a handful of large prompts saturate the accelerators.
- **The dominant part of that cost is unknown at arrival.** Prompt length is
  known from tokenizing; output length is known only when generation stops.

So admission cannot be one decision.

| | |
|---|---|
| **Input** | `(tenant, model, promptTokens, maxOutputTokens, sloTtftMs?)` over HTTP |
| **Output** | admit + a reservation id, or shed + a reason mapped to 400/429/503 |
| **Optimises** | Admitting as much traffic as a token budget and a fixed pool of GPU slots can actually serve, without letting any tenant exceed its budget |
| **State** | Token and request balances, leases and estimators in Redis; policies in PostgreSQL |

There is **no LLM behind this service** `[CODE]`. It sits beside the inference
path, not in it: a gateway calls `reserve` before dispatching to a model and
`commit` after generation finishes. The service never sees a prompt or a token.

## 1.3 Current project status

**Research-grade prototype with production-shaped engineering; not deployed.**
`[INFERRED from the following facts]`

| Fact | Evidence |
|---|---|
| Compiles, boots, serves, and is exercised end-to-end by CI | `[CODE: .github/workflows/ci.yml:78-102]` |
| 103 tests across 10 suites against real Redis and real PostgreSQL, 81.6% statements | `[TEST]` |
| Benchmarked with committed raw artifacts and a repeat-with-spread harness | `[ARTIFACT: bench/results/]` |
| Security-audited; 11 confirmed findings fixed | `[GIT: 84c723b, d681d67]`, `[DOC: SECURITY.md]` |
| Has never run outside one workstation and CI | `[INFERRED]` — no deployment manifests, no infra-as-code, no staging references |
| Redis Cluster support is a key-layout claim, never exercised | `[DOC: docs/DESIGN.md]`, `[CODE]` — hash tags present, no cluster client |
| Three defects found during **this** audit remain open | `[PROBE]` — see §17 |

The repository was **transformed on a single day**, 2026-09-06, from a
non-functioning HTTP rate limiter into this. See §2.

## 1.4 Current capabilities

Real, exercised, and covered by tests:

1. **Three-phase token admission** — `reserve` / `commit` / `release`, with lease
   expiry reclaimed inline on the admission path `[CODE][TEST]`.
2. **Atomic decisions** — refill, compare, deduct, lease and expiry sweep in one
   Lua script per operation, so N replicas cannot over-admit by N `[CODE]`.
3. **Idempotent commit** — a retried commit is recognised and does not
   double-charge; one marker key per reservation with its own TTL `[CODE][TEST]`.
4. **Two reservation policies** — `worst_case` (never overruns) and `adaptive`
   (EWMA estimate × safety factor, clamped to the declared ceiling) `[CODE][TEST]`.
5. **Shed reasons with distinct status codes** — 429 budget, 503 capacity, 400
   unsatisfiable `[CODE][TEST]`.
6. **SLO-aware shedding** — a request predicted to miss `sloTtftMs` is shed
   rather than queued into a timeout `[CODE][TEST]`.
7. **Policy control plane** — pattern-matched policies in PostgreSQL with
   priority, cached 30s, invalidated on write, gated by an API key `[CODE][TEST]`.
8. **Generic HTTP rate limiting** — token bucket, sliding window, fixed window,
   with a stored-rule engine that now reaches the decision path `[CODE][TEST]`.
9. **Configurable failure modes** — `fail_open` / `fail_closed` per surface,
   every degraded response labelled `[CODE][TEST]`.
10. **A local stack with no Docker and no root** `[CODE: scripts/devstack.sh]`.
11. **A measurement harness that reports its own reliability** — median and
    max/min spread across repeated sweeps `[CODE: bench/repeat.sh][ARTIFACT]`.

## 1.5 Current limitations

| Limitation | Evidence |
|---|---|
| Single-threaded; capacity comes from replicas, not cores | `[ARTIFACT]` gateway CPU tracks offered load linearly to ~80% of one core |
| Measured tail is only reproducible below ~1,000 admission cycles/s **on the audit host** | `[ARTIFACT: bench/results/repeat-summary.txt]` |
| No production trace; the reservation result's magnitude depends on an assumed output-length distribution | `[CODE: bench/lib/workload.ts:14-15][DOC]` |
| Redis Cluster never deployed | `[DOC: docs/DESIGN.md]` |
| No streaming-aware reconciliation; one commit at the end | `[DOC: docs/DESIGN.md]` |
| No priority classes; batch and interactive contend identically | `[DOC: docs/DESIGN.md]` |
| One EWMA per (tenant, model), not per prompt shape | `[CODE: src/llm/admission-scripts.ts:217-224]` |
| Data plane is unauthenticated by design | `[CODE: src/middleware/auth.ts:11-14]` |
| **Commit discards refill accrued since the last balance write** | `[PROBE]` — §17.1, previously unrecorded |

## 1.6 The most important architectural idea

**Cost that is unknown at decision time must be held, then reconciled — and the
hold must have a deadline.**

Everything else follows. Holding requires a reservation identity. Reconciling
requires idempotency, because the reconcile call happens after a slow generation,
which is exactly when clients time out and retry. The deadline requires
reclamation, because clients die between the two calls as a matter of course.
Reclamation must not race reconciliation, which forces both into the same atomic
unit — hence Lua, and hence sweeping expiry *inside* the admission script rather
than in a background sweeper.

The failure this design exists to prevent is subtle and worth internalising: a
client that crashes between `reserve` and `commit` permanently burns a slice of
its tenant's budget. The tenant's effective quota decays toward zero while
**every individual decision remains correct**, so there is no error to point at
and no alert that fires `[CODE: src/llm/types.ts:20-24]`.

## 1.7 Fastest mental model

Three layers, and a fourth that only observes:

```
  Control plane    who is allowed what        PostgreSQL, cached 30s
  Decision         can this request proceed   Redis + Lua, atomic, per request
  Accounting       what did it actually cost  Redis + Lua, at commit
  ─────────────────────────────────────────────────────────────────
  Observation      histograms and counters    prom-client, in-process
```

Or, in one line: **it is a bank that lends against an estimate, settles when the
borrower returns, and repossesses when they do not.**

---

# 2. Project evolution

## 2.1 Timeline

`[GIT]` — `git log --format='%h %ad %s' --date=short --all`

| Date | Commit | Event |
|---|---|---|
| 2025-11-17 | `a15a6bd` | "Implement production-grade rate limiter service" |
| 2025-11-18 | `9ad35a7` | "Add Phase 2 - Dynamic Rule Management System" |
| *(10-month gap)* | | |
| 2026-08-15/16 | `ff5cd92`…`da0b33d` | 17 commits on a parallel branch, `claude/tokengate-admission-control-gvsgvh` |
| 2026-09-06 | `233bdee`…`252ae91` | 12 commits: the current line of work |
| 2026-09-06 | — | The parallel branch was archived and deleted from the remote |

## 2.2 What the first version was, and what was wrong with it

The original two commits produced a Redis-backed HTTP rate limiter with three
algorithms, a PostgreSQL-backed rule engine, Prometheus metrics, a Dockerfile and
a docker-compose stack.

**It had never been executed once.** `[GIT][DOC: README.md §Engineering log]`

| Symptom | Consequence |
|---|---|
| 14 TypeScript errors | `npm run build` failed, so `npm start`, `npm run db:migrate` and the Dockerfile's `RUN npm run build` had all never succeeded |
| 2 of 3 test suites did not compile; the third was 8 tautologies at 0% coverage | The 70% coverage threshold could not have been met |
| `prometheus.yml` scraped a port nothing bound, and scraped Redis over RESP | No metrics were ever collected |
| `findMatchingRule()` had zero callers | The entire "Phase 2" rule engine was dead code |
| README documented `P99 < 10ms`, `100K+ req/s`, `99.99% uptime` | No benchmark code existed in the repository |

This is the origin of the project's most distinctive property: **every number in
its documentation now carries the command that produced it and the artifact it
was read from.**

## 2.3 The abandoned parallel branch

Between 2026-08-15 and 2026-08-16 a separate line of work, "TokenGate", built an
overlapping solution: admission control, plus an OpenAI-compatible data plane, a
tokenizer client, provider failover, retry budgets, systemd and nginx deployment
configs, and a Grafana dashboard. `[GIT]`

It was **archived and deleted from the remote on 2026-09-06** because a secret
scan flagged an API-key literal in its history. Triage established the literal
was a synthetic test fixture generated by that branch's own key generator, used
as a parsing fixture, referenced by no non-test source file, and unable to
authenticate to anything — but a string that pattern-matches a real credential is
indistinguishable from one to any scanner or reader. `[GIT][DOC]`

```
Archive: /home/coder-gw/Engineering/Rate-Limiter-Service-archive/
  tokengate-admission-control-gvsgvh.bundle   (19 commits, tip da0b33d)
  README.md                                   (why, what is in it, how to restore)
```

> **WARNING** — the bundle is a faithful copy of that history and therefore still
> contains the fixture. Keep it out of any repository and off anything public.

**Work that exists only in that archive**, not carried forward: an
OpenAI-compatible adapter (`src/providers/`), a tokenizer client
(`src/tokenizer/`), `deploy/` (systemd units, nginx config), `grafana/`
(provisioned dashboard), and docs `ARCHITECTURE.md` / `DEPLOYMENT.md` /
`OPERATIONS.md` / `DESIGN_DECISIONS.md`.

> Its `docs/LOAD_RESULTS.md` reports numbers produced against an **in-process
> mock provider**. That branch says so plainly, but those figures are not
> measurements of a real backend.

**Why two branches solved the same problem independently: `[UNKNOWN]`.** The
repository contains no issue tracker, no design doc predating either, and no
commit message referencing the other. Both branches independently found and fixed
the same token-bucket refill bug (`17333f9` on the archived branch, `f72ff3b`
here), which is the strongest available evidence that they did not communicate.

## 2.4 The 2026-09-06 transformation

Twelve commits, ordered dependencies-first. `[GIT]`

| Commit | What it established |
|---|---|
| `233bdee` | Compiles at all; security-relevant defaults changed from fail-open to fail-closed |
| `f72ff3b` | Token bucket stopped discarding fractional refill; script loading made correct |
| `862ed38` | Rule engine connected to the decision path; TOCTOU on rule creation removed |
| `c85bdc8` | **The LLM admission layer** — this is the project's actual contribution |
| `02ce09f` | Six defects on the request path (logging cost, metric cardinality, 500-for-400, uncounted requests, CORS, body limit) |
| `4c6142e` | The test suite, against real servers |
| `695c362` | The no-Docker local stack |
| `7e58013` | The benchmark harness, including the machinery that reports when a number is not trustworthy |
| `d681d67` | Lockfile committed; two reachable CVEs closed; `uuid` dependency dropped |
| `84c723b` | Deployment hardening: the compose file's default admin credential removed |
| `f9fb461` | Invented performance figures replaced with measured ones; two previously published numbers retracted |
| `252ae91` | Suppressed one scanner's reading of another scanner's audit record |

## 2.5 Numbers this project published and then retracted

Kept in `README.md`'s engineering log rather than quietly corrected. Both matter
for calibrating trust in the remaining numbers. `[DOC: README.md:408-546][ARTIFACT]`

| Retracted claim | What re-measurement showed |
|---|---|
| p99 2,538 ms at 2,000 cycles/s; safe operating point 1,000 | 1.48 ms median across five sweeps of the same code on the same host. **Cause never identified.** The artifact recorded node version, platform and core count, but nothing about host load — on a shared workstation |
| "205x p99 improvement from removing per-request logging" | Across four controlled A/B pairs the two arms' p99 overlap (239, 6.7, 21.4, 7.4 vs 10.2, 17.6, 17.9, 5.0). Only CPU (97–103% vs 89–91%) and log volume (101,203 vs 1 line) are consistent |

The response to the first was structural: the harness now records host load
average in every artifact, and the reported table is the **median of five sweeps
with the range and max/min spread beside it**.

## 2.6 Historical baggage still in the tree

| Item | Status |
|---|---|
| Generic HTTP rate limiter (`/api/v1/check-rate-limit`, `/api/v1/rules`) | **Active but peripheral.** Fully working and tested; unrelated to the project's thesis. Retained, not deprecated |
| `src/services/rule-engine.service.ts` | Original style — `// Rule Engine Service` block comments, `CACHE_TTL` constant naming — against the newer files' prose comments. Functionally current |
| `src/app.ts:62` `version: '2.0.0'` | Stale: `package.json` says `3.0.0` `[CODE]` |
| `src/routes/health.routes.ts:7` `?? '2.0.0'` | Same stale fallback |
| `@types/uuid` in devDependencies | The `uuid` runtime dependency was removed in `d681d67`; the types package was not `[CODE: package.json]` |
| `blockedRequestsTotal` `key` label | Declared, but always set to the literal `'unknown'` `[CODE: src/services/metrics.service.ts:179]` |

---

# 3. System architecture

```
                    ┌──────────────────────────────────────────┐
   operator ───────▶│  CONTROL PLANE   (API-key gated)         │
   (curl / CD)      │  POST/PUT/DELETE /api/v1/llm/policies    │
                    │  /api/v1/rules                            │
                    └───────────────┬──────────────────────────┘
                                    │ writes + cache invalidate
                                    ▼
                            ┌───────────────┐
                            │  PostgreSQL   │  llm_admission_policies
                            │               │  rate_limit_rules
                            └───────┬───────┘  rule_hit_stats
                                    │ read every 30s, cached in-process
                                    ▼
  inference     ┌──────────────────────────────────────────────────┐
  gateway  ────▶│  DATA PLANE   (no authentication — see §16)      │
  (yours)       │                                                  │
                │  POST /api/v1/llm/reserve   ── phase 1           │
                │  POST /api/v1/llm/commit    ── phase 2           │
                │  POST /api/v1/llm/release   ── phase 2, zero use │
                │  GET  /api/v1/llm/state     ── read-only         │
                │                                                  │
                │  POST /api/v1/check-rate-limit  (generic HTTP)   │
                └───────────────┬──────────────────────────────────┘
                                │ one Lua script per operation
                                ▼
                        ┌───────────────┐
                        │     Redis     │  llm:{tenant|model}:tpm      balance
                        │               │  llm:{tenant|model}:tpm:ts   refill clock
                        │  (all state   │  llm:{tenant|model}:rpm(+ts)
                        │   that must   │  llm:{tenant|model}:leases   ZSET id→expiry
                        │   be exact)   │  llm:{tenant|model}:res      HASH id→held
                        │               │  llm:{tenant|model}:stats    HASH ewma
                        └───────────────┘  llm:{tenant|model}:settled:<id>
                                │
                                ▼
                    ┌───────────────────────┐
                    │  prom-client registry │ ── GET /metrics
                    │  (in-process, per     │     (scraped by Prometheus)
                    │   replica)            │
                    └───────────────────────┘
```

## 3.1 Layer responsibilities

### Control plane

| | |
|---|---|
| **Implementation** | `src/routes/admission.routes.ts:178-238`, `src/routes/rules.routes.ts` |
| **Guard** | `requireControlPlaneKey` — `src/middleware/auth.ts:36` |
| **Storage** | `src/llm/policy.repository.ts`, `src/repositories/rule.repository.ts` |
| **Input** | JSON policy or rule objects, Joi-validated |
| **Output** | 201 / 200 / 204 / 401 / 404 / 503 |
| **Failure mode** | 503 `CONTROL_PLANE_UNCONFIGURED` when the key is unset under `NODE_ENV=production`; open in development `[CODE: src/middleware/auth.ts:43-58]` |
| **Known defect** | A duplicate `(tenant_pattern, model_pattern)` returns **500, not the documented 409** — §17.2 |

### Policy resolution

| | |
|---|---|
| **Implementation** | `src/llm/policy.resolver.ts` (singleton) |
| **Input** | `(tenant, model)` |
| **Output** | an `AdmissionPolicy` — always one; falls back to `DEFAULT_POLICY` |
| **Cache** | 30 s TTL on the policy *set*; a per-pair `Map` cleared on every reload |
| **Concurrency** | Concurrent refreshes collapse into one query via a `loading` promise `[CODE:48]` |
| **Failure mode** | On a PostgreSQL error, serves the last known set and **advances `loadedAt` anyway** — so it does not hot-loop the database. On a cold cache this leaves the set empty and every lookup gets `DEFAULT_POLICY` `[CODE:56-62]` |

### Decision (admission)

| | |
|---|---|
| **Implementation** | `src/llm/admission.service.ts` → `ADMIT_SCRIPT` in `src/llm/admission-scripts.ts:29` |
| **Input** | 7 Redis keys, 14 ARGV values |
| **Output** | 9-element array: `{admitted, reason, reserve, tpmBal, rpmBal, inflight, predictedWait, retryAfterMs, reclaimed}` |
| **Atomicity** | Whole decision is one script; Redis runs scripts to completion |
| **Failure mode** | `guardState('admission', …)` → 503 by default; never fails open unless `ADMISSION_FAILURE_MODE=fail_open` |

### Accounting (commit)

| | |
|---|---|
| **Implementation** | `src/llm/admission.service.ts:164` → `COMMIT_SCRIPT` at `admission-scripts.ts:157` |
| **Input** | 6 keys (incl. a per-reservation settled marker), 9 ARGV |
| **Output** | `{status, refundedTokens, tokensRemaining, inflight}`; status 1/2/3 |
| **Failure mode** | **Not guarded.** Errors go to `next(error)` → 500, deliberately: silently losing a commit leaves the hold until the lease expires `[CODE: src/routes/admission.routes.ts:129-134]` |
| **Known defect** | Discards refill accrued since the last balance write — §17.1 |

---

# 4. Call chains

## 4.1 Admission (the critical path)

```text
POST /api/v1/llm/reserve
  → src/app.ts:38          requestLogger            (registered BEFORE body parsing)
  → src/app.ts:46          express.json({limit: 64kb})
  → src/app.ts:54          app.use('/api/v1/llm', admissionRoutes)
  → src/routes/admission.routes.ts:90   validateRequest(reserveSchema)
  → src/routes/admission.routes.ts:91   guarded(...)         [degraded-mode wrapper]
      → policyResolver.resolve(tenant, model)
          → (cache miss or >30s) policyRepository.findEnabledByPriority()
              → SELECT * FROM llm_admission_policies WHERE enabled = true
                ORDER BY priority DESC, created_at ASC
          → matchPattern(tenant, p.tenantPattern) && matchPattern(model, p.modelPattern)
          → first match, else DEFAULT_POLICY
      → admissionService.reserve(req.body, policy)
          → observedOutputTokens()   HGET llm:{t|m}:stats out_tokens   [adaptive only]
          → estimateReservation()    src/llm/estimator.ts:24
          → randomUUID()             node:crypto
          → admitScript.run(7 keys, 14 argv)
              → src/algorithms/script-runner.ts:53  EVALSHA <sha1>
                  → ADMIT_SCRIPT:
                      phase 1  ZRANGEBYSCORE leases -inf now LIMIT 0 32   [sweep]
                               HGET/HDEL res, ZREM leases                 [per expired]
                      phase 2  refill(tpm), refill(rpm)                   [fractional]
                               ZCARD leases                               [inflight]
                               HGET stats svc_ms                          [wait predictor]
                      phase 3  ordered constraint check                   [see §4.2]
                      phase 4  SET tpm/tpm:ts/rpm/rpm:ts + EXPIRE         [BOTH paths]
          → metricsService.recordAdmission / recordReservation / setInflight
  → res.set(X-RateLimit-Tokens-Remaining, X-RateLimit-Requests-Remaining,
            X-Admission-Inflight [, Retry-After])
  → res.status(STATUS_BY_REASON[reason] ?? 200).json(result)
  → res.on('finish') in requestLogger → recordApiRequest + recordApiLatency
```

## 4.2 The constraint order inside `ADMIT_SCRIPT`

Order is load-bearing: the **first** matching condition is the reason returned.
`[CODE: src/llm/admission-scripts.ts:91-108]`

```text
1. reserve > tpm_limit            → unsatisfiable   400, NO Retry-After
2. rpm_bal < 1                    → rpm_exhausted   429, Retry-After = (1-rpm)/rate
3. tpm_bal < reserve              → tpm_exhausted   429, Retry-After = (reserve-tpm)/rate
4. inflight >= concurrency+queue  → queue_full      503, Retry-After = avg_svc
5. slo_ttft > 0 && wait > slo     → slo_infeasible  503, Retry-After = avg_svc
6. otherwise                      → ADMIT
```

`unsatisfiable` is checked first and deliberately carries **no** `Retry-After`:
the request is larger than the tenant's entire per-minute budget, so telling the
caller to retry invites a hot loop `[CODE: admission.service.ts:151-154]`.

## 4.3 Commit

```text
POST /api/v1/llm/commit
  → validateRequest(commitSchema)          reservationId must be a UUID
  → policyResolver.resolve()
  → admissionService.commit()
      → commitScript.run(6 keys, 9 argv)
          → COMMIT_SCRIPT:
              GET settled:<id>  →  present? return {3, …}   [duplicate_ignored]
              HGET res <id>     →  absent?  held=0, status=2 [reconciled_after_expiry]
                                   present? HDEL res, ZREM leases
              refund = held - actual         (negative on overrun)
              bal = min(bal + refund, tpm_limit)
              SET tpm, SET tpm:ts=now, SET settled:<id> EX 300
              EWMA update: svc_ms, out_tokens, out_peak
      → status 3 → duplicate_ignored | 2 → reconciled_after_expiry | 1 → committed
      → refund < 0 → metricsService.recordOverrun()
  → 200 JSON
```

## 4.4 Generic HTTP rate limiting

```text
POST /api/v1/check-rate-limit
  → src/routes/rate-limit.routes.ts
  → rateLimiterService.check(request, overrides)
      → resolveLimit()
          → all three overrides present?  → source: 'request'
          → ruleEngineService.findMatchingRule(context)
              → getEnabledRules()  [60s cache]  → ruleRepository.findEnabledRulesByPriority()
              → isRuleMatch() per dimension: global | user | ip | endpoint | custom
              → first match wins (already priority-ordered)
          → matched?  → source: 'rule'   (request fields still win field-by-field)
          → else      → source: 'default' from config.defaults
      → AlgorithmFactory.getAlgorithm(effective.algorithm).check(key, limit, window)
          → RedisScript → EVALSHA (TOKEN_BUCKET | SLIDING_WINDOW | FIXED_WINDOW)
      → metricsService.recordCheckLatency  [process.hrtime.bigint, not Date.now]
  → 200 or 429, plus X-RateLimit-Policy naming the governing rule
```

## 4.5 Experiment path

```text
./bench/repeat.sh 5 20 250 500 1000 1500 2000 2500 3000
  → (per repeat) ./scripts/serve.sh restart          [cold gateway each sweep]
  → (per repeat) ./bench/sweep.sh 20 <rates...>
      → cpu_ticks() from /proc/<pid>/stat            [utime+stime, not ps %cpu]
      → npx tsx bench/bench-admission.ts --duration 20 --rates <one rate>
          → WorkloadGenerator (seeded mulberry32, CHAT_WORKLOAD)
          → open loop: sleepUntil(absolute deadline)  [no coordinated omission]
          → per request: POST /reserve  then  POST /commit
          → Latencies → p50/p95/p99/p99.9/max
          → footer: node version, platform, cpus, LOAD AVERAGE
      → bench/results/rate-<n>.txt
  → cp to bench/results/repeat/run<r>-rate-<n>.txt
  → uptime >> bench/results/repeat/load.txt
  → inline python3: median + range + max/min spread per rate
```

## 4.6 Startup

```text
node dist/index.js
  → src/index.ts:9  bootstrap()
      → redisService.connect()          [ioredis, retryStrategy caps at maxRetries]
      → postgresService.connect()
      → AlgorithmFactory.warmAll() + admissionService.warm()
            SCRIPT LOAD every Lua body   ← so the first post-deploy request of each
                                           kind does not pay to ship a script
      → createApp()
      → app.listen(config.server.port, config.server.host)
      → SIGTERM/SIGINT → server.close() → disconnect both → exit 0
        backstop setTimeout(30s).unref()
```

---

# 5. Repository map

132 tracked files, 9,699 lines excluding `package-lock.json` and benchmark
artifacts; 52 committed artifact files under `bench/results/`.

### `src/llm/` — the project's contribution

| File | Lines | Role |
|---|---:|---|
| `admission-scripts.ts` | 252 | **The three Lua scripts.** This is the implementation; the TypeScript around it is plumbing |
| `admission.service.ts` | 292 | Key namespacing, TTL sizing, script invocation, metric emission |
| `types.ts` | 157 | `AdmissionRequest/Result`, `ShedReason`, `CommitStatus`, `AdmissionPolicy`, `DEFAULT_POLICY` |
| `policy.repository.ts` | 175 | PostgreSQL CRUD. `PolicyRow` types BIGINT/NUMERIC as `string` because that is what node-postgres returns |
| `policy.resolver.ts` | 87 | Pattern + priority resolution, 30 s cache, stale-on-error |
| `estimator.ts` | 53 | `worst_case` vs `adaptive` reservation sizing |

**Depended on by:** `src/routes/admission.routes.ts`, `src/index.ts`, and the
benchmarks (over HTTP, not by import).

### `src/algorithms/` — generic limiter primitives

| File | Role |
|---|---|
| `script-runner.ts` | `RedisScript`: local SHA1, EVALSHA, reload **only** on NOSCRIPT, latency histogram |
| `token-bucket.ts` | Thin wrapper; the only algorithm supporting a weighted `cost` |
| `sliding-window.ts` | Exact, no boundary burst; costs `limit` sorted-set members per key |
| `fixed-window.ts` | Cheapest; permits up to 2× `limit` across a boundary. `reset()` derives keys arithmetically — the previous `redis.keys(pattern)` was an O(keyspace) block on a caller-reachable path |
| `index.ts` | `AlgorithmFactory`, `warmAll()` |

### `src/services/`

| File | Role | Note |
|---|---|---|
| `metrics.service.ts` | prom-client registry, 18 metrics | See §17.4 for a cardinality risk |
| `rate-limiter.service.ts` | `resolveLimit()` + `check()` | Where "Phase 2" was reconnected |
| `rule-engine.service.ts` | Dimension matching, 60 s cache | Oldest code in the tree; `possibly legacy` in style, current in function |
| `redis.service.ts` | ioredis singleton | Throws `RedisConnectionError` when never connected |
| `postgres.service.ts` | `pg.Pool` singleton | |

### `src/middleware/`

| File | Role |
|---|---|
| `request-logger.ts` | Histogram + logs only for 5xx and slow requests. Route label is `req.route?.path \|\| req.baseUrl \|\| 'unmatched'` — `\|\|` not `??`, because an unmatched request carries an empty-string `baseUrl` |
| `error-handler.ts` | Terminal handler. **Records no metrics** (the request logger already does, with the right label) and does not log a stack for a client's mistake |
| `degraded-mode.ts` | `guardState(surface, openResponse)` — recognises both `RedisConnectionError` and ioredis message shapes |
| `auth.ts` | `requireControlPlaneKey`, constant-time compare, same-length comparison run even on a length mismatch |
| `validate-request.ts` | Joi wrapper |

### `src/routes/`

`admission.routes.ts` (240) · `rules.routes.ts` (292) · `rate-limit.routes.ts`
(149) · `health.routes.ts` (55) · `metrics.routes.ts`.

### `bench/` — measurement

| File | Role | Recommended entry point? |
|---|---|---|
| `repeat.sh` | 5 sweeps, median + range + spread | **Yes — this is the one that produces the published table** |
| `sweep.sh` | One sweep across rates, with `/proc` CPU | Yes, for a quick look |
| `bench-admission.ts` | Benchmark A: open-loop reserve+commit latency | Called by the sweeps |
| `bench-reservation.ts` | Benchmark B: worst_case vs adaptive on replayed traffic | `npm run bench:reservation` |
| `sweep-reservation.sh` | Benchmark B across assumed output medians | `npm run bench:reservation:sweep` |
| `logging-ab.sh` | Controlled A/B on per-request logging cost | Direct |
| `lib/stats.ts` | Percentiles, `sleepUntil` (absolute deadlines), seeded mulberry32, table formatting | Library |
| `lib/workload.ts` | `CHAT_WORKLOAD`, log-normal generator | Library |

### `bench/results/` — committed evidence

**Not `.gitignore`d, deliberately** `[CODE: .gitignore]`. A performance claim
whose artifact is not in the repository is a claim the reader must take on trust.

| Pattern | Produced by |
|---|---|
| `rate-<n>.txt` | one `sweep.sh` run, one file per offered rate |
| `repeat/run<r>-rate-<n>.txt` | the 5 sweeps behind the published table |
| `repeat/load.txt` | `uptime` before each sweep |
| `repeat-summary.txt` | the aggregate table |
| `reservation-default.txt` | Benchmark B at the documented workload |
| `reservation-median-<n>.txt` | Benchmark B sensitivity sweep |
| `logging-ab.txt` | the logging A/B |
| `README.md` | what each file is, and what is real vs assumed |

### `scripts/` — local environment

| File | Role | Environment constraint |
|---|---|---|
| `devstack.sh` | Redis + PostgreSQL from a conda env, no Docker, no root | **Requires the conda env at `$RL_CONDA_ENV`, default `~/miniconda3/envs/ratelimiter`** |
| `devstack.env.sh` | `source` this to point the process at the dev stack | Must be sourced, not executed |
| `serve.sh` | build + run + pidfile + health-wait, on `:3055` | Depends on `devstack.env.sh` |

### `src/__tests__/`

| Suite | Cases | Covers |
|---|---:|---|
| `llm/admission.test.ts` | 19 | Reserve/commit/expire semantics against real Redis |
| `api/admission.api.test.ts` | 18 | HTTP contract, status codes, headers |
| `services/rule-engine.test.ts` | 12 | Every dimension, priority, caching |
| `algorithms/window-algorithms.test.ts` | 10 | Sliding + fixed window |
| `utils/pattern.test.ts` | 10 | Glob/regex/exact matching, metacharacter escaping |
| `api/rate-limit.api.test.ts` | 9 | That stored rules reach the decision path |
| `algorithms/token-bucket.test.ts` | 7 | Fractional refill regression |
| `api/control-plane.api.test.ts` | 7 | Auth, 401, 503-when-unconfigured |
| `api/degraded.api.test.ts` | 6 | fail_open / fail_closed |
| `api/errors.api.test.ts` | 5 | 400-not-500, metric cardinality, single counting |
| `support/env.ts`, `support/redis.ts` | — | Harness. DB 15 so a stray run cannot touch app data |

### Not covered by tests

- `src/index.ts` — excluded from coverage; exercised by the CI smoke job only
- `src/scripts/migrate.ts` — excluded; exercised by CI running it
- **The commit-path refill behaviour** — §17.1 exists precisely because nothing asserts it
- Redis Cluster key routing — no cluster is ever started
- Graceful shutdown ordering — no test sends SIGTERM

---

# 6. Core abstractions

## 6.1 `RedisScript` — `src/algorithms/script-runner.ts`

| | |
|---|---|
| **Responsibility** | Execute a Lua body by SHA, shipping the body only when the server says it does not have it |
| **Lifecycle** | Constructed once at module load; lives for the process |
| **Key fields** | `body`, `numKeys`, `name`, `sha` (computed locally with `createHash('sha1')` — no round trip) |
| **Methods** | `run(keys, args)`, `load()` |
| **Constructed by** | `admission.service.ts:17-19`; each algorithm module |
| **Invariant** | `keys.length === numKeys`, enforced with a throw naming the script `[CODE:32-36]` |
| **Errors** | Only a `NOSCRIPT` reply triggers a reload. Everything else propagates — the previous version caught *every* EVALSHA error and retried with EVAL, hiding genuine Lua errors as cache misses |
| **Concurrency** | Stateless after construction; safe to share |
| **Persistence** | None. `load()` warms the server-side cache |

## 6.2 `AdmissionPolicy` — `src/llm/types.ts:127`

| Field | Default | Meaning |
|---|---:|---|
| `tokensPerMinute` | 100,000 | The budget that binds for most LLM workloads |
| `requestsPerMinute` | 600 | Guards against many tiny requests |
| `maxConcurrency` | 16 | In-flight requests the backend can serve — GPU slots |
| `maxQueueDepth` | 64 | Additional requests allowed to wait |
| `leaseSeconds` | 120 | How long a hold survives without a commit |
| `reservationMode` | `worst_case` | `worst_case` never overruns; `adaptive` recovers stranded budget |
| `reservationSafetyFactor` | 1.5 | Multiplier on the estimate; `adaptive` only |
| `enabled` | `true` | **See §17.3 — this field does not do what the route implies** |

**Lifecycle:** produced by `PolicyResolver.resolve()` per request, either from a
`StoredPolicy` (spread with `tenant`/`model` overwritten to the *concrete*
values) or from `DEFAULT_POLICY`. Never persisted in this shape.

**Invariant:** `resolve()` always returns a policy. There is no "no policy" path
`[CODE: policy.resolver.ts:37-39]`.

## 6.3 The Redis key set — one namespace per (tenant, model)

`ns = llm:{<tenant>|<model>}` `[CODE: admission.service.ts:41-43]`

The braces are a **Redis Cluster hash tag**, not decoration. Without them a
multi-key script spanning budgets, leases and stats is rejected as a cross-slot
command the moment the deployment grows past one node.

| Key | Type | Written by | TTL |
|---|---|---|---|
| `<ns>:tpm` | string (float as text) | admit, commit | `max(120, leaseSeconds*2+60)` |
| `<ns>:tpm:ts` | string (ms epoch) | admit, commit | same |
| `<ns>:rpm`, `<ns>:rpm:ts` | string | admit only | same |
| `<ns>:leases` | ZSET `id → expiryMs` | admit (ZADD), commit (ZREM), sweep (ZREM) | same |
| `<ns>:res` | HASH `id → tokensHeld` | admit (HSET), commit (HDEL), sweep (HDEL) | same |
| `<ns>:stats` | HASH `svc_ms`, `out_tokens`, `out_peak` | commit | same |
| `<ns>:settled:<reservationId>` | string (refund as text) | commit | `COMMIT_IDEMPOTENCY_TTL`, default 300 s |

**Why the settled marker is one key per reservation and not a hash field:** hash
fields have no individual TTL. The earlier design grew with throughput for the
whole life of the hash; a benchmark run left **218,000 fields** under a single
tenant `[DOC: admission-scripts.ts:150-155]`.

**Invariant:** budget keys must outlive the longest lease
(`ttlSeconds = max(120, leaseSeconds*2 + 60)`), otherwise a reservation could
return to commit against a balance that has silently reset to full
`[CODE: admission.service.ts:66-72]`.

## 6.4 `PolicyResolver` — `src/llm/policy.resolver.ts`

| | |
|---|---|
| **Responsibility** | Map `(tenant, model)` to the governing policy |
| **Lifecycle** | Module singleton, lives for the process |
| **State** | `policies[]` (the set), `resolved: Map` (per-pair), `loadedAt`, `loading` |
| **Concurrency** | A `loading` promise collapses concurrent refreshes into one query |
| **Invariant** | The `resolved` map is cleared on every set reload, so a policy write cannot be masked by a stale per-pair entry |
| **Growth** | `resolved` is bounded only by the number of distinct pairs seen within one 30 s window `[CODE:41]`. Under high tenant cardinality this is a per-window allocation, not a leak — but it is unbounded within the window `[INFERRED]` |
| **Errors** | Advances `loadedAt` even on failure, so a database outage does not become a query storm |

## 6.5 `guardState` — `src/middleware/degraded-mode.ts:34`

A curried handler wrapper: `guardState(surface, openResponse)(handler)`.

| | |
|---|---|
| **Recognises** | `RedisConnectionError`, plus an ioredis message regex covering `Connection is closed`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `ENOTFOUND`, `Stream isn't writeable`, `max retries` |
| **Invariant** | Every degraded response carries `X-RateLimit-Degraded` and a `degraded` body field. Quietly returning `allowed: true` during an outage is how a limiter comes to look healthy while enforcing nothing |
| **Applied to** | Two surfaces. `guardState('admission', …)` wraps **`/reserve` only** — not `/commit`, `/release` or `/state`. `guardState('rateLimit', …)` wraps the generic limiter's check path `[CODE: admission.routes.ts:20,91; rate-limit.routes.ts:16]` |

---

# 7. Configuration reference

## 7.1 Mechanism

There is no YAML/TOML layer. Configuration is **environment variables only**,
read in two places:

1. `src/config/index.ts` — `dotenv.config()` then a single frozen object, read at
   **module load**. Changing the environment after boot has no effect.
2. Scattered direct `process.env` reads, at module load or per request:

| Variable | Read at | Location |
|---|---|---|
| `COMMIT_IDEMPOTENCY_TTL` | module load | `src/llm/admission.service.ts:32` |
| `SLOW_REQUEST_LOG_MS` | module load | `src/middleware/request-logger.ts:10` |
| `CORS_ORIGIN` | `createApp()` | `src/app.ts:26` |
| `MAX_BODY_SIZE` | `createApp()` | `src/app.ts:45` |
| `npm_package_version` | module load | `src/routes/health.routes.ts:7` |

**Precedence:** process environment → `.env` (via dotenv) → hardcoded default.
There is no CLI override for anything except the benchmarks, which take `--flag`
arguments.

## 7.2 Parameter table

| Parameter | Default | Meaning | Read by | Dangerous values |
|---|---|---|---|---|
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | Where all decision state lives | `config.redis` | Pointing two deployments at one Redis merges their budgets |
| `REDIS_DB` | `0` | Logical DB | `config.redis` | Tests use 15; sharing 15 with anything destroys it (`flushdb`) |
| `REDIS_PASSWORD` | unset | | `config.redis` | Unset + a published port = an open Redis |
| `REDIS_MAX_RETRIES` | `3` | Reconnect attempts before giving up | `config.redis` | `0` makes any blip a hard failure |
| `POSTGRES_*` | `localhost:5432/rate_limiter/postgres` | Policy storage | `config.postgres` | |
| `POSTGRES_MAX_CONNECTIONS` | `20` | Pool size | `config.postgres` | Below ~5 serialises policy reloads |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listener | `config.server` | `0.0.0.0` in a shared network exposes an unauthenticated data plane |
| `NODE_ENV` | `development` | | `config.server.env` | **`production` is what makes the control plane fail closed** |
| `CONTROL_PLANE_API_KEY` | unset | Gates policy + rule writes | `config.auth` | Unset + `NODE_ENV≠production` = an open control plane |
| `RATE_LIMIT_FAILURE_MODE` | `fail_open` | Generic limiter on Redis loss | `config.failure` | `fail_open` means an outage silently stops limiting |
| `ADMISSION_FAILURE_MODE` | `fail_closed` | LLM admission on Redis loss | `config.failure` | `fail_open` here floods a GPU pool unmetered |
| `COMMIT_IDEMPOTENCY_TTL` | `300` (s) | How long a settled reservation is remembered | `admission.service.ts` | Very large values reintroduce unbounded key growth; very small ones let a slow retry double-charge |
| `SLOW_REQUEST_LOG_MS` | `250` | Above this, one warn line per request | `request-logger.ts` | **`0` logs every request** — that is the A/B's "B" arm, ~8–12% of a core at 2,500 cycles/s |
| `CORS_ORIGIN` | unset → **no** cross-origin | Comma-separated origins | `app.ts` | Re-introducing `*` puts an unauthenticated data plane in reach of any web page |
| `MAX_BODY_SIZE` | `64kb` | JSON/urlencoded body cap | `app.ts` | Large values let one caller spend the event loop parsing. **Undocumented — §17.6** |
| `ENABLE_METRICS` | on unless exactly `'false'` | | `config.monitoring` | |
| `LOG_LEVEL` | `info` (silent under `NODE_ENV=test` unless set) | | `config.logging` | `debug` restores per-request logging |
| `LOG_FORMAT` | `json` | | `config.logging` | |
| `DEFAULT_ALGORITHM` / `DEFAULT_RATE_LIMIT` / `DEFAULT_WINDOW_SECONDS` | `token_bucket` / `1000` / `60` | Generic limiter fallback when no rule matches | `config.defaults` | Changing these silently changes every unmatched request's limit |

Compose-only, never read by `src/`: `GATEWAY_BIND` (which interface the gateway's
port is published on) and `GRAFANA_ADMIN_PASSWORD` `[CODE: docker-compose.yml]`.

Dev-stack-only: `RL_CONDA_ENV` (default `~/miniconda3/envs/ratelimiter`)
`[CODE: scripts/devstack.sh:10]`.

## 7.3 Parameters that must change together

| Group | Why |
|---|---|
| `leaseSeconds` and `COMMIT_IDEMPOTENCY_TTL` | Budget key TTL is derived from the lease (`lease*2+60`); the idempotency TTL is independent. If the idempotency TTL exceeds the budget TTL, a settled marker can outlive the balance it settled against `[INFERRED]` |
| `maxConcurrency` and `maxQueueDepth` | `queue_full` fires at `concurrency + queue`; `predictedWaitMs` is computed from concurrency alone. Raising queue without raising concurrency lengthens waits rather than adding capacity |
| `reservationMode: adaptive` and `reservationSafetyFactor` | The safety factor only has an effect under `adaptive` `[CODE: estimator.ts:32-34]` |
| Benchmark `--tpm` and `--burst` and `--output-median` | Changing any one makes results incomparable across runs; the sweep exists because of this |

## 7.4 Parameters that break comparability of results

Re-running a benchmark after changing any of these invalidates every previously
recorded number:

- `CHAT_WORKLOAD.seed` (`bench/lib/workload.ts:34`) — the workload is only
  reproducible because this is fixed at `20260830`
- `--output-median`, `--output-sigma`, `--ceiling` on `bench-reservation.ts`
- `--tpm`, `--burst`, `--calibration`
- `SLOW_REQUEST_LOG_MS` and `LOG_LEVEL` — both change how much CPU the logger takes
- The host's load average — recorded in each artifact precisely because it once was not

---

# 8. Data flow and artifact lifecycle

## 8.1 Runtime state

```
  request                policy                     budget
     │                      │                          │
     ▼                      ▼                          ▼
  HTTP JSON ──▶ AdmissionRequest ──▶ AdmissionPolicy ──▶ Lua ARGV
                                          ▲                │
                            PostgreSQL row│                ▼
                            (30s cache)   │           Redis strings/ZSET/HASH
                                          │                │
                                          │                ▼
                                          │           9-element Lua reply
                                          │                │
                                          │                ▼
                                          │           AdmissionResult ──▶ HTTP JSON
                                          │                │
                                          │                ▼
                                          │           prom-client counters
                                          └────────── (in-process, per replica)
```

**Nothing is written to disk by the service itself.** All runtime state is in
Redis (ephemeral, TTL'd) or PostgreSQL (durable, operator-managed).

## 8.2 Artifact classification

| Path | Class | Can be deleted? | Regenerated by |
|---|---|---|---|
| `bench/results/*.txt` | **Source of truth for every number in `README.md`** | Only if you re-run and replace | `./bench/repeat.sh 5 20`, `npm run bench:reservation`, `./bench/sweep-reservation.sh` |
| `bench/results/README.md` | Hand-written provenance note | No | — |
| `.devstack/` | Local Redis AOF, PostgreSQL cluster, service log + pidfile | Yes — `./scripts/devstack.sh reset` | `./scripts/devstack.sh up` |
| `dist/` | Build output | Yes | `npm run build` |
| `coverage/` | Derived | Yes | `npm test` |
| `node_modules/` | Derived, pinned | Yes | `npm ci` |
| `package-lock.json` | **Source of truth for the dependency set** | **No** — `npm ci` fails without it | `npm install` (changes the pin) |
| `.secrets.baseline` | detect-secrets audit record | No — re-triage cost | `detect-secrets scan` |
| `.gitleaksignore` | Fingerprint suppressions | No | Hand-written |
| `/home/coder-gw/Engineering/Rate-Limiter-Service-archive/*.bundle` | Archive of a deleted branch, **outside the repo** | No | Cannot be regenerated; the remote branch is gone |

## 8.3 Naming rules

| Pattern | Meaning |
|---|---|
| `bench/results/rate-<offered>.txt` | One sweep, one offered rate. **Overwritten** by the next `sweep.sh` at the same rate |
| `bench/results/repeat/run<r>-rate-<n>.txt` | Repeat `r` of a `repeat.sh` invocation. **The whole `repeat/` directory is `rm -rf`'d at the start of every `repeat.sh` run** `[CODE: bench/repeat.sh:22]` |
| `bench/results/reservation-median-<n>.txt` | Benchmark B at assumed output median `n` |

> **WARNING** — `bench/repeat.sh` begins with `rm -rf bench/results/repeat`. If
> you want to keep a prior 5-sweep set, copy it out first. There is no versioning.

---

# 9. Experiment inventory

## 9.1 Benchmark A — admission decision cost

| | |
|---|---|
| **Purpose** | How much latency does asking permission add, and at what offered rate does the answer stop being acceptable |
| **Hypothesis** | The decision is cheap enough to sit in front of every inference; the ceiling is the Node thread, not Redis |
| **Entry point** | `./bench/repeat.sh 5 20 250 500 1000 1500 2000 2500 3000` |
| **Inner driver** | `bench/bench-admission.ts` via `bench/sweep.sh` |
| **Method** | Open loop against absolute deadlines; fresh client process per rate; cold gateway per sweep; budgets far above offered load so nothing is shed |
| **Workload** | `CHAT_WORKLOAD`, seed `20260830` |
| **Hardware** | 32 cores, Linux; Node v26.7.0; Redis 8.10.1 and PostgreSQL 18.6 over loopback |
| **Host load** | 4.0–5.8 throughout, recorded in `bench/results/repeat/load.txt` |
| **Output** | `bench/results/repeat/`, `bench/results/repeat-summary.txt` |
| **Metric** | p50/p95/p99 of the `reserve` call, plus achieved rate, gateway CPU, Redis CPU |
| **Official result** | Yes — `README.md:112-165` |
| **Reproducible** | Yes below ~2,000 cycles/s. Above that, no — and that is the finding |

**Published result** `[ARTIFACT]`:

| offered | achieved | p50 | p95 | p99 | p99 range | spread | gw CPU | redis CPU |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 250 | 250 | 0.43 | 0.55 | 0.70 | 0.65–0.71 | 1.1× | 10% | 0% |
| 500 | 500 | 0.41 | 0.52 | 0.61 | 0.59–0.63 | 1.1× | 20% | 0% |
| 1000 | 1000 | 0.44 | 0.59 | 0.73 | 0.71–0.89 | 1.3× | 30% | 10% |
| 1500 | 1500 | 0.47 | 0.70 | 1.09 | 0.91–2.51 | 2.8× | 50% | 10% |
| 2000 | 2000 | 0.63 | 0.91 | 1.48 | 1.44–6.05 | 4.2× | 60% | 20% |
| 2500 | 2499 | 0.72 | 1.30 | 6.91 | 2.87–29.01 | **10.1×** | 70% | 20% |
| 3000 | 2999 | 0.72 | 2.08 | 9.55 | 3.23–17.99 | **5.6×** | 80% | 30% |

**Known anomaly, still unexplained `[UNKNOWN]`:** the previously published table
for the same code on the same host reported p99 2,538 ms at 2,000 cycles/s. The
discrepancy is three orders of magnitude, with the same request count, no
shedding and no errors. The cause was never identified.

**Interpretation as published:** capacity is **1,000 admission cycles/s per
replica** — the highest rate where the tail repeats to within 1.3×. Not 3,000,
even though the service serves 2,999 of 3,000 offered.

## 9.2 Benchmark B — worst-case vs adaptive reservation

| | |
|---|---|
| **Purpose** | Quantify what adaptive reservation buys and what it costs |
| **Hypothesis** | Callers declare far more than they use, so reserving the ceiling strands most of a budget |
| **Entry point** | `npm run bench:reservation` and `./bench/sweep-reservation.sh` |
| **Configuration** | tpm 400,000; burst 400 arriving together; calibration 150; ceiling 4096 |
| **Seed** | `20260830`, fixed |
| **Output** | `bench/results/reservation-default.txt`, `reservation-median-<n>.txt` |
| **Official result** | Yes — `README.md:166-229` |
| **Reproducible** | Yes — verified identical across 3 consecutive runs during the work that produced it |

**Published result at the documented workload** `[ARTIFACT]`:

| mode | admitted | admitted % | mean held | mean used | held but unused |
|---|---:|---:|---:|---:|---:|
| `worst_case` | 75 | 18.8% | 5341 | 1471 | 72.5% |
| `adaptive` | 230 | 57.5% | 1739 | 1516 | 12.9% |

Overrun cost of `adaptive`: 29 of 230 (12.6%), 6,372 tokens, **1.83% of tokens used**.

**Sensitivity — this is the honest form of the result** `[ARTIFACT]`:

| assumed output median | unused declaration | worst_case | adaptive | advantage |
|---:|---:|---:|---:|---:|
| 90 | 74.3% | 75 | 267 | 3.56× |
| 180 | 72.0% | 75 | 230 | 3.07× |
| 400 | 66.2% | 75 | 174 | 2.32× |
| 900 | 54.0% | 75 | 112 | 1.49× |
| 2000 | 35.0% | 75 | 74 | **0.99×** |

> **The 72% figure is an input, not a finding.** It is arithmetic on a log-normal
> distribution chosen to resemble chat traffic, with median 180 against a 4096
> ceiling. No traffic was measured to obtain it `[CODE: bench/lib/workload.ts:14-15]`.
> The last row is the honest reading: once callers declare close to what they
> use, adaptive reservation buys nothing and its overrun risk is not worth carrying.

**A self-consistency check is built into the sweep:** `worst_case` admits exactly
75 at every point, because it reserves the declared ceiling and ignores what is
generated, so its count *cannot* depend on the output distribution. An earlier
version showed it varying 42→0, which is what exposed that the calibration phase
was draining the budget before the measured burst began `[DOC][GIT: 7e58013]`.

## 9.3 Benchmark C — per-request logging A/B

| | |
|---|---|
| **Purpose** | Quantify what a log line per request costs |
| **Entry point** | `./bench/logging-ab.sh 2500 20` |
| **Method** | Same binary, same load, back to back; arms differ only in `SLOW_REQUEST_LOG_MS` (0 = every request logs) |
| **Output** | `bench/results/logging-ab.txt` |
| **Official result** | Partially — the CPU and log-volume figures are; the latency figure was **retracted** |

| arm | CPU (% of one core), 4 runs | log lines / 20 s |
|---|---|---:|
| a line per request | 103, 97, 98, 98 | 101,203 |
| histogram (current) | 91, 91, 89, 89 | 1 |

p99 across the same four pairs: 239, 6.7, 21.4, 7.4 vs 10.2, 17.6, 17.9, 5.0 —
**overlapping**, so the latency effect is not separable from contention on this
host and is no longer claimed.

## 9.4 Not experiments

`bench/results/rate-<n>.txt` at the top level are single-sweep runs. They are
inputs to exploration, **overwritten in place**, and are not the source of any
published table — `repeat/` is. Treat a top-level `rate-*.txt` as scratch unless
its timestamp matches a `repeat/` set.

---

# 10. Quick start

Five to ten minutes, to confirm the repository works.

```bash
cd /home/coder-gw/Engineering/Rate-Limiter-Service

# 1. Dependencies (lockfile is committed; npm ci is exact)
npm ci

# 2. Real Redis + real PostgreSQL, no Docker, no root
./scripts/devstack.sh up

# 3. Schema
npm run build && source scripts/devstack.env.sh && node dist/scripts/migrate.js up

# 4. Run it on :3055
./scripts/serve.sh start

# 5. Walk the protocol
curl -s -X POST localhost:3055/api/v1/llm/policies \
  -H 'Content-Type: application/json' \
  -d '{"tenantPattern":"acme","modelPattern":"*","tokensPerMinute":5000,
       "maxConcurrency":2,"maxQueueDepth":2}'

RES=$(curl -s -X POST localhost:3055/api/v1/llm/reserve \
  -H 'Content-Type: application/json' \
  -d '{"tenant":"acme","model":"llama-70b","promptTokens":900,"maxOutputTokens":1600}')
echo "$RES"

ID=$(echo "$RES" | python3 -c 'import json,sys; print(json.load(sys.stdin)["reservationId"])')

curl -s -X POST localhost:3055/api/v1/llm/commit \
  -H 'Content-Type: application/json' \
  -d "{\"tenant\":\"acme\",\"model\":\"llama-70b\",\"reservationId\":\"$ID\",
       \"promptTokens\":900,\"outputTokens\":180,\"serviceMs\":1500}"
```

**Expected** `[PROBE — this exact sequence was run during this audit]`:

```text
{"decision":"admit","reservationId":"…","reservedTokens":2500,
 "tokensRemaining":2500,"requestsRemaining":599,"inflight":1,
 "predictedWaitMs":0,"reclaimed":0}

{"status":"committed","refundedTokens":1420,"tokensRemaining":3920,"inflight":0}
```

`reservedTokens` is 2500 because the default `reservationMode` is `worst_case`:
900 prompt + 1600 declared ceiling. The commit refunds 1420, the difference
between the 2500 held and the 1080 actually used.

**If it fails:**

| Symptom | Means |
|---|---|
| `devstack.sh` dies with "redis-server not found" | The conda env is missing — see §11.2 |
| `npm ci` errors `EUSAGE` | `package-lock.json` is absent; you are on a checkout predating `d681d67` |
| `serve.sh` "failed to become healthy" | Read `.devstack/service.log`; usually Redis or PostgreSQL is not up |
| `reserve` returns `"decision":"shed"` | A policy from a previous run is still in the database with a small budget |
| `commit` returns 500 | Redis is unreachable; commit is deliberately never failed open |

---

# 11. Reproducing from a fresh machine

## 11.1 Assumptions

You have git, a Linux x86-64 host, and the repository. Root is **not** required.

## 11.2 Full sequence

```bash
# --- clone -----------------------------------------------------------------
git clone git@github.com:GeoffreyWang1117/Rate-Limiter-Service.git
cd Rate-Limiter-Service
# default branch is feat/llm-admission-control

# --- Node ------------------------------------------------------------------
# package.json engines: node >=20, npm >=10.  CI uses 22.  Measured on 26.7.0.
node --version
npm ci

# --- data stores, without Docker -------------------------------------------
conda create -y -n ratelimiter -c conda-forge redis-server postgresql
./scripts/devstack.sh up            # Redis :6399, PostgreSQL :55432, data in .devstack/

# --- schema ----------------------------------------------------------------
npm run build
source scripts/devstack.env.sh
node dist/scripts/migrate.js up

# --- smoke test ------------------------------------------------------------
npm run verify                      # typecheck, lint, build, test with coverage
# expect: 10 suites, 103 tests, ~81.6% statements, 0 lint problems

# --- run -------------------------------------------------------------------
./scripts/serve.sh start            # :3055

# --- full experiment: Benchmark A (the published table) --------------------
./bench/repeat.sh 5 20 250 500 1000 1500 2000 2500 3000
#   ~12 minutes.  Writes bench/results/repeat/ and prints the aggregate.
#   WARNING: rm -rf's bench/results/repeat first.

# --- full experiment: Benchmark B ------------------------------------------
npm run bench:reservation           # the headline table
./bench/sweep-reservation.sh        # the sensitivity sweep

# --- validation ------------------------------------------------------------
# Compare your aggregate against bench/results/repeat-summary.txt.
# The p99 spread column is the thing to compare, not the p99 itself:
# a quiet host should show a smaller spread, a busy one a larger.
```

**Alternative with Docker** (requires daemon access):

```bash
make docker-secrets                 # writes .env with generated secrets
docker compose up -d --build        # gateway :3000 (loopback), Prometheus :9091, Grafana :3001
```

The compose file declares its four secrets as `${VAR:?}` and refuses to start
without them `[PROBE — `docker compose config` errors by name]`.

## 11.3 What cannot be reproduced

| Item | Why |
|---|---|
| The archived branch's results | Its `LOAD_RESULTS.md` was produced against an in-process mock provider that only exists in the bundle |
| The retracted p99 2,538 ms figure | Never reproduced; cause unknown |
| Anything on Redis Cluster | Never deployed `Unverified` |
| The Docker path on the audit host | The Docker daemon required privileges the auditor did not hold. Compose findings were confirmed by running the app with the exact environment the compose file produces `[DOC: SECURITY.md]` |

---

# 12. Environment and dependencies

## 12.1 Versions

| Component | Audit host | CI | Docker image | Declared |
|---|---|---|---|---|
| Node | **v26.7.0** | 22 | `node:22-alpine` | `>=20` |
| TypeScript | **5.9.3** | from lockfile | from lockfile | `^5.3.3` |
| Redis | **8.10.1** (conda-forge) | `redis:7-alpine` | `redis:7-alpine` | — |
| PostgreSQL | **18.6** (conda-forge) | `postgres:16-alpine` | `postgres:16-alpine` | — |
| OS | Linux 7.0.0-29-generic | ubuntu-latest | alpine | — |

> **Provenance caveat `[CODE][INFERRED]`.** Every published number was measured
> on Redis 8.10.1 and PostgreSQL 18.6 under Node 26.7.0. CI and the Docker image
> run Redis 7 and PostgreSQL 16 under Node 22. The measured stack is **not** the
> deployed stack, and nothing in the repository quantifies the difference.

## 12.2 Runtime dependencies

`express@^4.18.2` · `ioredis@^5.3.2` · `pg@^8.11.3` · `joi@^17.11.0` ·
`prom-client@^15.1.0` · `winston@^3.11.0` · `helmet@^7.1.0` · `cors@^2.8.5` ·
`compression@^1.7.4` · `dotenv@^16.3.1`

One override: `qs: ^6.16.0`, pinned above what Express 4 selects, because
`qs` 6.15.3 carries a denial of service through an attacker-controlled
`isBuffer` and an array-limit bypass — both on the query-string parser, which
every request reaches `[GIT: d681d67]`.

`npm audit --omit=dev` reports **0 vulnerabilities** `[PROBE]`.

## 12.3 Platform assumptions

| Assumption | Where | Consequence if violated |
|---|---|---|
| `/proc/<pid>/stat` exists | `bench/sweep.sh:32`, `bench/logging-ab.sh` | CPU columns read `0` on non-Linux |
| `getconf CLK_TCK` | same | CPU arithmetic breaks |
| `bc` on `PATH` | `bench/sweep.sh:50-52` | Sweep prints empty CPU |
| `uptime` | `bench/repeat.sh` | Load provenance lost |
| conda env at `$RL_CONDA_ENV` | `scripts/devstack.sh:10` | Dev stack cannot start |
| `python3` | `bench/repeat.sh`, `sweep-reservation.sh` | Aggregation fails |
| Bash (not sh) | all `scripts/`, `bench/*.sh` | `BASH_SOURCE`, arrays |

**No GPU, CUDA, ROCm or accelerator is required or referenced anywhere.** This
service models a GPU pool through `maxConcurrency`; it never touches one.

---

# 13. Hardware requirements

| Tier | CPU | RAM | Disk | Evidence |
|---|---|---|---|---|
| **Smoke test** (`npm run verify` + quick start) | 2 cores | ~2 GB | ~1 GB for `node_modules`, `dist`, `.devstack` | `[INFERRED]` — single-threaded service plus two small servers |
| **Development** | 4 cores | 4 GB | 2 GB | `[INFERRED]` |
| **Full experiment** (`repeat.sh 5 20 …`) | **Enough idle cores that the load generator and the gateway do not contend.** The published run used 32 cores at load average 4.0–5.8 | 4 GB | ~1 MB of artifacts | `[ARTIFACT: bench/results/repeat/load.txt]` |

> The full-experiment requirement is not a CPU count, it is **quiet**. The
> project's own history contains a three-order-of-magnitude unexplained
> discrepancy attributed to unrecorded host contention. Run benchmarks on an
> otherwise-idle machine and check the load average the artifact records.

Redis memory during the published benchmarks peaked well under the 256 MB dev cap:
`used_memory 1.49M`, `evicted_keys 0` `[PROBE]`.

Network: none required — everything is loopback. A real deployment adds a network
hop to Redis that will dominate the sub-millisecond p50 reported here `[DOC]`.

---

# 14. Concurrency, distribution and system assumptions

## 14.1 Process and thread model

- **One process, one thread for HTTP.** Node's event loop serves every request.
  Gateway CPU tracks offered load linearly to ~80% of one core `[ARTIFACT]`.
- **No clustering.** `README.md` names it as a known limit: it would need a
  metrics registry shared across workers.
- **Horizontal scaling is the intended answer**, and works because the gateway is
  stateless — all state is in Redis, and every decision is one atomic script.

## 14.2 Correctness under replication

| Property | Mechanism |
|---|---|
| N replicas cannot over-admit by N | Refill, compare, deduct, lease and expiry sweep are one Lua script; Redis runs scripts to completion `[CODE][DOC: docs/DESIGN.md]` |
| Expiry cannot double-credit a concurrent commit | The sweep runs *inside* the admit script, so no commit can interleave with it `[CODE: admission-scripts.ts:50-64]` |
| A retried commit cannot double-charge | Per-reservation `settled` marker checked first `[CODE:175-179][TEST]` |
| Cluster-safety of multi-key scripts | Hash tag `llm:{tenant\|model}` puts every key for one pair in one slot `[CODE]` — **untested** |

## 14.3 Hidden assumptions

| Assumption | Where | Consequence if violated |
|---|---|---|
| **One Redis, or a cluster where hash tags hold.** | Everywhere | Cross-slot rejection at the first multi-key script |
| **`Date.now()` on the gateway is the authority for `now`.** | `admission.service.ts:85,181` — `now` is computed in Node and passed as ARGV | Clock skew between replicas makes leases expire early or late. Redis's own clock is never consulted `[CODE][INFERRED]` |
| **The caller reliably calls commit or release.** | Whole protocol | Leases bound the damage, but `llm_lease_reclaims_total` rising is the only signal |
| **`maxConcurrency` reflects real backend capacity.** | Wait prediction | The service has no way to observe actual GPU occupancy; `inflight` is its own count of uncommitted reservations |
| **`avg_svc` (EWMA of `serviceMs`) is representative.** | `predicted_wait` | `serviceMs` is optional on commit; if callers omit it, the predictor stays at `COLD_START_SERVICE_MS = 2000` forever and `slo_infeasible` decisions are made against a constant `[CODE: admission-scripts.ts:80]` |
| **The dev stack's Redis is not shared.** | `flushdb` in tests | Tests use DB 15; anything else on DB 15 is destroyed |
| **Two benchmark runs do not share an output directory.** | `bench/results/` | `sweep.sh` overwrites `rate-<n>.txt`; `repeat.sh` `rm -rf`s `repeat/`. Parallel runs corrupt each other `[CODE]` |
| **Artifacts are written non-atomically.** | All bench scripts use `>` redirection | A killed run leaves a truncated file that later parsers read as valid `[INFERRED]` |

## 14.4 Retry, timeout, idempotency

| Operation | Idempotent? | Rationale |
|---|---|---|
| `reserve` | **No, deliberately** | A retried reserve is a genuinely new request for capacity; the first is released by its lease. Deduplicating would require an idempotency key the caller has no reason to have `[DOC: docs/DESIGN.md]` |
| `commit` | **Yes** | Called after a slow generation, exactly when clients time out and retry |
| `release` | Yes | Implemented as `commit` with zero usage `[CODE: admission.service.ts:226-236]` |
| `state` | Yes, read-only | `SNAPSHOT_SCRIPT` performs no writes |

---

# 15. Failure modes and debugging

Ordered by how often you will actually hit them.

### Redis unreachable

| | |
|---|---|
| **Symptom** | `/reserve` returns 503 `LIMITER_UNAVAILABLE` with `X-RateLimit-Degraded: fail_closed`; `/health` returns 503 |
| **Detection** | `rate_limiter_degraded_responses_total` non-zero; `/health/ready` fails |
| **Cause** | Redis down, or `REDIS_HOST`/`REDIS_PORT` wrong |
| **Fix** | `./scripts/devstack.sh status`; check `.devstack/redis/redis.log` |
| **Note** | `/commit` is **not** guarded and returns 500 instead. This is deliberate `[CODE]` |

### PostgreSQL unreachable

| | |
|---|---|
| **Symptom** | Admission keeps working. `/health` reports `"status":"degraded"` with `postgres: down` |
| **Cause** | The resolver serves its last known policy set `[CODE: policy.resolver.ts:56-62]` |
| **Danger** | On a **cold** cache the set is empty and every request silently gets `DEFAULT_POLICY` (100k TPM). A restart during a PostgreSQL outage therefore hands every tenant the default budget |
| **Detection** | `GET /api/v1/llm/policies/cache` → `{"policies": 0}` |

### Build fails / `npm ci` fails

| | |
|---|---|
| **`EUSAGE ... can only install with an existing package-lock.json`** | You are on a checkout predating `d681d67`. Use `npm install`, or check out a newer commit |
| **Type errors** | `npx tsc --noEmit`. CI runs this before build |

### Tests fail

| Symptom | Cause |
|---|---|
| `ECONNREFUSED 127.0.0.1:6399` | Dev stack not up |
| `duplicate key value violates unique constraint "unique_policy_scope"` | Leftover rows from an interrupted run. Suites clean their own prefixes in `beforeEach`; a killed run can leave rows |
| Coverage below threshold | `jest.config.js` thresholds are set just under what the suite achieves, so any regression trips the build |
| Suites interfere | `maxWorkers: 1` is mandatory — suites share one Redis DB and `flushdb` between cases `[CODE: jest.config.js:8]` |

### Benchmark produces nonsense

| Symptom | Check |
|---|---|
| p99 spread > 5× | The host was busy. Read `bench/results/repeat/load.txt` |
| `shed` column non-zero | Budgets are binding; you are measuring the shed path, not the decision path |
| `worst_case` admitted count varies across output medians in Benchmark B | Calibration is leaking into the measurement. The benchmark now throws rather than report this `[CODE: bench-reservation.ts]` |
| CPU columns empty | `bc` missing, or `/proc` unavailable |

### Port collision

`:3055` (dev gateway), `:6399` (dev Redis), `:55432` (dev PostgreSQL),
`:3000` (Docker gateway), `:9091` (Prometheus), `:3001` (Grafana).
`serve.sh` honours `PORT`; `devstack.sh` honours `REDIS_PORT` / `POSTGRES_PORT`.

### Recommended debugging order

1. `./scripts/devstack.sh status` — are the data stores up?
2. `curl -s localhost:3055/health | python3 -m json.tool` — which dependency?
3. `tail -50 .devstack/service.log` — the gateway's own log
4. `curl -s localhost:3055/metrics | grep -E 'degraded|reclaims|late_commits'`
5. `curl -s 'localhost:3055/api/v1/llm/state?tenant=X&model=Y'` — the tenant's actual budget
6. `curl -s localhost:3055/api/v1/llm/policies/cache` — is the policy set loaded?
7. `./scripts/devstack.sh redis-cli --scan --pattern 'llm:{X|Y}*'` — the raw keys
8. `LOG_LEVEL=debug ./scripts/serve.sh restart` — restores per-request logging

---

# 16. API reference

Base URL below: `http://localhost:3055` (dev stack). Docker serves `:3000`.

## 16.1 Data plane — **no authentication**

> **WARNING.** `/reserve`, `/commit`, `/release` and `/state` are unauthenticated
> by design `[CODE: src/middleware/auth.ts:11-14]`. A tenant name is an
> identifier, not a credential. Anyone who can reach these endpoints can spend
> any tenant's budget by guessing its name, and can mint Prometheus time series
> (§17.4). Put this behind network policy or your own auth before exposing it.

### `POST /api/v1/llm/reserve`

```json
{"tenant":"acme","model":"llama-70b","promptTokens":900,
 "maxOutputTokens":4096,"sloTtftMs":2000}
```

| Field | Required | Validation |
|---|---|---|
| `tenant`, `model` | yes | string, 1–128 chars |
| `promptTokens` | yes | integer 0–10,000,000 |
| `maxOutputTokens` | yes | integer 1–10,000,000 |
| `sloTtftMs` | no | integer 1–600,000 |

**200** — admitted. **400 / 429 / 503** — shed, per §4.2.
Headers on every response: `X-RateLimit-Tokens-Remaining`,
`X-RateLimit-Requests-Remaining`, `X-Admission-Inflight`, and `Retry-After` where
one applies.

### `POST /api/v1/llm/commit`

```json
{"tenant":"acme","model":"llama-70b","reservationId":"<uuid>",
 "promptTokens":900,"outputTokens":210,"serviceMs":1840}
```

`serviceMs` is optional but **keeps the wait predictor calibrated**; without it
from any caller, `slo_infeasible` decisions are made against a constant (§14.3).

Returns `status` ∈ `committed` | `reconciled_after_expiry` | `duplicate_ignored`,
plus `refundedTokens` (negative on overrun), `tokensRemaining`, `inflight`.

### `POST /api/v1/llm/release`

`{tenant, model, reservationId}` — equivalent to committing zero usage.

### `GET /api/v1/llm/state?tenant=&model=`

Read-only snapshot: `tokensRemaining`, `requestsRemaining`, `inflight`,
`expiredLeasesPending`, `avgServiceMs`, `avgOutputTokens`, `peakOutputTokens`,
`policy`.

## 16.2 Control plane — API-key gated

`Authorization: Bearer <key>` or `X-API-Key: <key>`.

| Method | Path | Documented | **Actual** |
|---|---|---|---|
| GET | `/api/v1/llm/policies` | 200 | 200 |
| POST | `/api/v1/llm/policies` | 201, **409 on duplicate scope** | 201, **500 on duplicate scope** — §17.2 |
| PUT | `/api/v1/llm/policies/:id` | 200 / 404 | as documented |
| DELETE | `/api/v1/llm/policies/:id` | 204 / 404 | as documented |
| GET | `/api/v1/llm/policies/cache` | resolver state | as documented |

`/api/v1/rules` mirrors this for the generic limiter and **does** return 409 on a
duplicate name `[PROBE]`.

## 16.3 Generic limiter

`POST /api/v1/check-rate-limit` · `POST /api/v1/reset` · `POST /api/v1/stats` ·
`/api/v1/rules` CRUD. Response carries `effective.source` ∈
`request` | `rule` | `default` and an `X-RateLimit-Policy` header naming the
governing rule.

## 16.4 Operational

`GET /health` (both dependencies; 503 when Redis is down) ·
`GET /health/ready` (fails without Redis) ·
`GET /health/live` (checks nothing external, by design) ·
`GET /metrics` (Prometheus text).

## 16.5 CLI

| Command | Purpose |
|---|---|
| `npm run verify` | typecheck → lint → build → test with coverage |
| `npm run db:migrate` / `node dist/scripts/migrate.js up` | Apply schema |
| `./scripts/devstack.sh {up\|down\|status\|reset\|psql\|redis-cli}` | Local data stores |
| `./scripts/serve.sh {start\|stop\|restart\|logs}` | Run the gateway on `:3055` |
| `./bench/repeat.sh [repeats] [duration] [rate…]` | The published Benchmark A table |
| `./bench/sweep.sh [duration] [rate…]` | One sweep |
| `npm run bench:reservation` | Benchmark B |
| `./bench/sweep-reservation.sh [median…]` | Benchmark B sensitivity |
| `./bench/logging-ab.sh [rate] [duration]` | Logging A/B |
| `make docker-secrets` | Generate `.env` with random secrets |

---

# 17. Defects found during this audit

All confirmed against a running instance. **None were fixed** — this was a
documentation-only pass.

## 17.1 `COMMIT_SCRIPT` discards refill accrued since the last balance write

**Severity: high. Previously unrecorded.** `[PROBE][CODE]`

`src/llm/admission-scripts.ts:194-205` reads the refill timestamp but never uses
it to accrue, then overwrites it with `now`:

```lua
local bal = tonumber(redis.call('GET', tpm_key))
local ts  = tonumber(redis.call('GET', tpm_ts_key))   -- read...
if bal == nil or ts == nil then bal = tpm_limit end   -- ...used only for this nil check
local refund = held - actual
bal = math.min(bal + refund, tpm_limit)
redis.call('SET', tpm_key, tostring(bal), 'EX', ttl)
redis.call('SET', tpm_ts_key, tostring(now), 'EX', ttl)   -- clock advances anyway
```

`ADMIT_SCRIPT` refills and advances the clock. `COMMIT_SCRIPT` advances the clock
**without** refilling. So the interval between an admission and its commit — that
is, the whole generation window — never accrues tokens.

**Reproduction** (tpm 600,000 → 10,000 tokens/s refill):

```text
balance right after draining          : 60
balance after 5s, read via /state     : 50080     (snapshot DOES refill: +50020)
commit -> refund=200000, tokensRemaining=200050
balance after commit                  : 200070
  if commit had applied elapsed refill: ~250060
  if commit discarded elapsed refill  : ~200060   ← matches
```

**Impact.** A tenant is systematically under-credited by roughly one generation
window of refill per commit. Under steady traffic that is a large fraction of the
effective rate. The symptom is identical to the token-bucket bug this project's
engineering log celebrates fixing (`f72ff3b`): traffic inside its configured
budget receives 429.

**Why no test caught it.** No test asserts the balance after a commit that
follows a measurable delay. `src/__tests__/llm/admission.test.ts` asserts refund
arithmetic, not refill arithmetic.

**Not fixed here.** The shape of a fix is to apply the same `refill()` helper
`ADMIT_SCRIPT` uses before applying the refund — but note the ordering question
(refill-then-refund vs refund-then-refill) changes behaviour at the `tpm_limit`
clamp, and both `SNAPSHOT_SCRIPT` and `ADMIT_SCRIPT` would need to agree.

## 17.2 Duplicate policy scope returns 500, documentation says 409

**Severity: medium.** `[PROBE]`

```text
POST /api/v1/llm/policies  (tenantPattern=X, modelPattern=*)  → 201
POST /api/v1/llm/policies  (same)                             → 500
  {"error":{"code":"INTERNAL_SERVER_ERROR","message":"An unexpected error occurred"}}
```

For contrast, the rules endpoint on the same server returns **409 CONFLICT**.

**Cause.** `RuleRepository.create()` wraps its insert and maps Postgres `23505`
to `ConflictError`. `PolicyRepository.create()` (`src/llm/policy.repository.ts:109`)
does not, so the driver error reaches the generic handler. The machinery already
exists — `isUniqueViolation()` and `ConflictError` are exported from
`src/utils/errors.ts:47-63` and simply are not used here.

**Documentation conflict.** `API.md:174` and `README.md` both state 409.

## 17.3 `enabled: false` on a policy is dead code at the route

**Severity: low (correctness of documentation, not of enforcement).** `[PROBE][CODE]`

`src/routes/admission.routes.ts:95-98`:

```ts
if (!policy.enabled) {
  res.status(200).json({ decision: 'admit', reason: 'policy_disabled' });
  return;
}
```

This branch can never be taken. `PolicyResolver.resolve()` loads policies through
`findEnabledByPriority()`, which filters `WHERE enabled = true`, and its fallback
`DEFAULT_POLICY` has `enabled: true`. So `policy.enabled` is always true here.

**Probe.** A disabled policy with `tokensPerMinute: 10` at priority 9000 was
created, then a request reserving 100 tokens was admitted — it fell through to
the `*` catch-all. `reason: policy_disabled` never appears.

**What `enabled: false` actually means:** *remove this policy from
consideration*, so the next-highest match or the default applies. It does **not**
disable admission control. Any operator reading the route would conclude the
opposite.

## 17.4 Prometheus labels are driven by the unauthenticated data plane

**Severity: medium (availability).** `[PROBE][CODE]`

`llm_admission_decisions_total`, `llm_tokens_reserved_total`,
`llm_tokens_worst_case_total`, `llm_lease_reclaims_total`,
`llm_late_commits_total`, `llm_overrun_tokens_total` and `llm_inflight_requests`
are all labelled `['tenant', 'model']` `[CODE: src/services/metrics.service.ts:87-137]`.

Both values come straight from an unauthenticated request body. Every distinct
`(tenant, model)` string creates a permanent time series in the in-process
registry, which is never evicted.

**Probe.** After deleting all probe data from Redis and PostgreSQL, the live
registry still served series for those tenants:

```text
llm_admission_decisions_total{tenant="refillprobe-1788895885",model="m",outcome="admit"} 2
llm_admission_decisions_total{tenant="disabledprobe-1788895910",model="m",outcome="admit"} 1
```

This is the same class of defect the error handler was fixed for in `02ce09f` —
that fix removed `req.path` as a label but left tenant/model in place.

**Note the asymmetry:** `rate_limiter_blocked_requests_total` declares a `key`
label and then always passes the literal `'unknown'` `[CODE:179]` — cardinality-safe
but a dead label.

## 17.5 Dev stack and Docker disagree about Redis eviction policy

**Severity: low today, latent.** `[PROBE][CODE]`

| | `maxmemory` | `maxmemory-policy` |
|---|---|---|
| `scripts/devstack.sh:37-38` | 256 mb | **`allkeys-lru`** |
| `docker-compose.yml:85` | 512 mb | `noeviction` |

The compose file carries an explicit comment that `allkeys-lru` "would evict live
rate-limit counters under memory pressure, silently resetting budgets." The dev
stack — the environment every published number was measured in — uses exactly
that policy.

**No eviction actually occurred:** `evicted_keys: 0`, `used_memory 1.49M` against
a 256 MB cap `[PROBE]`. The published numbers are not compromised. A longer or
larger run could cross the cap, and the failure would be silent.

## 17.6 `MAX_BODY_SIZE` is read but documented nowhere

**Severity: low.** `[CODE][PROBE]`

Read at `src/app.ts:45`. Absent from `.env.example` and from `README.md`'s
configuration table. An operator cannot discover the knob that controls how much
JSON a caller may make the event loop parse.

## 17.7 Smaller items

| Item | Location | Note |
|---|---|---|
| `new RegExp(value)` on an operator-supplied pattern | `src/services/rule-engine.service.ts` `matchCustomPattern` | ReDoS reachable through a stored rule. Control-plane gated, so it requires the API key |
| Stale version string `2.0.0` | `src/app.ts:62`, `src/routes/health.routes.ts:7` | `package.json` says `3.0.0` |
| `@types/uuid` still in devDependencies | `package.json` | The runtime dependency was removed in `d681d67` |
| Non-atomic artifact writes | all `bench/*.sh` | A killed run leaves a truncated file that parsers accept |
| `bench/repeat.sh` destroys prior results | `bench/repeat.sh:22` | `rm -rf bench/results/repeat` with no versioning |

---

# 18. Documentation discrepancies

| # | Documentation says | Code does | Where |
|---|---|---|---|
| 1 | `POST /api/v1/llm/policies` returns **409** on a duplicate scope | Returns **500** | `API.md:174`, `README.md` vs `src/llm/policy.repository.ts:109` |
| 2 | The `policy_disabled` path implies `enabled:false` turns admission off | The branch is unreachable; a disabled policy is merely skipped | `src/routes/admission.routes.ts:95` |
| 3 | `README.md` metrics table: "`rate_limiter_api_latency_seconds` labelled by route template, not path" | The label is literally **named** `path`; it *holds* a template | `src/services/metrics.service.ts:57-62` |
| 4 | Service version `2.0.0` | `package.json` version is `3.0.0` | `src/app.ts:62` |
| 5 | `.env.example` is presented as the complete configuration surface | `MAX_BODY_SIZE` is read but absent | `.env.example` vs `src/app.ts:45` |
| 6 | Compose comments warn that `allkeys-lru` silently resets budgets | The dev stack uses `allkeys-lru` | `docker-compose.yml:85` vs `scripts/devstack.sh:38` |

Documentation that is **accurate and unusually careful**, and worth trusting:
the engineering log's retractions, the `bench/results/README.md` real-vs-assumed
split, `docs/DESIGN.md`'s "What is not here" section, and `SECURITY.md`'s
"Not verified" section.

---

# 19. Design decisions

Each states what the repository actually records as the reason. Where it records
none, that is said.

### Why one Lua script instead of a read-modify-write with a lock

**Evidence:** `docs/DESIGN.md` §"Why the whole decision is one Lua script"; the
scripts themselves.
**Decision:** refill, compare, deduct and lease in one script.
**Trade-off:** the decision logic lives in Lua, harder to read and impossible to
unit-test in isolation — which is *why* the tests run against a real Redis.
**Alternative cost:** splitting across round trips lets two replicas read the same
balance and both admit, so over-admission is proportional to replica count, and it
is worst exactly when the budget is nearly spent.

### Why expiry is swept inline, not by a background job

**Evidence:** `docs/DESIGN.md` §"Why expiry is swept inline"; `admission-scripts.ts:10-14`.
**Decision:** bounded sweep (32) at the top of the admit script.
**Trade-off:** a few extra Lua operations on every admission.
**Alternative cost:** a sweeper is another process to deploy, monitor and elect a
leader for; it returns budget on its own schedule; and it introduces the one race
the protocol most needs to avoid — refunding a hold at the moment its owner
commits it.

### Why the balance may go negative

**Evidence:** `docs/DESIGN.md` §"Why the balance is allowed to go negative".
**Decision:** an overrun is charged as a negative refund; the tenant refills out
of the hole.
**Alternative cost:** clamping at zero makes tokens beyond the reservation free,
turning underestimation into a strategy and making `adaptive` exploitable by
design rather than merely imprecise.

### Why commit is idempotent and reserve is not

**Evidence:** `docs/DESIGN.md` §"Why commit is idempotent and reserve is not".
**Decision:** per-reservation settled marker on commit; nothing on reserve.
**Rationale:** a retried reserve is a genuinely new request for capacity;
deduplicating it would require an idempotency key the caller has no reason to have.

### Why the two failure modes differ

**Evidence:** `docs/DESIGN.md`, `src/config/index.ts:48-66`.
**Decision:** `fail_open` for generic HTTP, `fail_closed` for LLM admission.
**Rationale:** unmetered traffic into a GPU pool does not degrade gracefully — it
queues until the backend collapses and *every* in-flight request is lost, not
just the excess. Refusing is recoverable in a way that overrunning is not.

### Why the estimator is an EWMA and not a quantile

**Evidence:** `docs/DESIGN.md` §"Why the estimator is an EWMA".
**Decision:** one float, one line of Lua, safety factor as a blunt stand-in.
**Explicitly acknowledged as the design's weakest point:** reserving at a p95 of
observed output would bound the overrun rate directly, which is the property an
operator actually wants to configure. A t-digest in Redis is named as the
principled replacement.

### Why `worst_case` is still the default

**Evidence:** `docs/DESIGN.md` §"Why `worst_case` is still the default".
**Rationale:** adaptive is a trade, not an improvement. "Defaults should be the
choice that cannot surprise anyone."

### Why the data plane is unauthenticated

**Evidence:** `src/middleware/auth.ts:11-14`, `SECURITY.md`.
**Rationale as recorded:** it is called by internal services on every request and
belongs behind network policy and mTLS at the mesh rather than behind a shared
secret in a header.
**Not recorded:** whether any mesh or network policy was ever specified. `[UNKNOWN]`

### Why `now` comes from the gateway rather than Redis

**No reason is recorded.** `[UNKNOWN]` `Date.now()` is computed in Node and
passed as ARGV to every script. `redis.call('TIME')` would remove the clock-skew
assumption but makes scripts non-deterministic, which historically mattered for
replication. The repository does not say which consideration drove the choice.

---

# 20. System invariants

Recovered from assertions, tests, script structure and documentation.

| # | Invariant | Enforced by |
|---|---|---|
| 1 | A reservation is settled at most once against the budget | `settled:<id>` marker checked first in `COMMIT_SCRIPT` `[CODE][TEST]` |
| 2 | Refill, compare, deduct and lease happen atomically | One Lua script; Redis runs scripts to completion `[CODE]` |
| 3 | Expiry cannot interleave with a concurrent commit | The sweep runs inside `ADMIT_SCRIPT` `[CODE]` |
| 4 | Budget key TTL > longest possible lease | `ttlSeconds = max(120, leaseSeconds*2 + 60)` `[CODE]` |
| 5 | Every key for one `(tenant, model)` lives in one Redis Cluster slot | Hash tag `llm:{t\|m}` `[CODE]` — **untested** |
| 6 | `RedisScript.run` receives exactly `numKeys` keys | Explicit throw `[CODE: script-runner.ts:32]` |
| 7 | Balances are persisted on both the admit and the shed path | `SET` calls sit outside the branch `[CODE: admission-scripts.ts:118-125]` |
| 8 | `PolicyResolver.resolve()` always returns a policy | Fallback to `DEFAULT_POLICY` `[CODE]` |
| 9 | A policy write takes effect on the writing replica immediately | `policyResolver.invalidate()` after every write `[CODE][TEST]` |
| 10 | Every degraded response is labelled | `X-RateLimit-Degraded` + `degraded` body field `[CODE][TEST]` |
| 11 | Prometheus route labels are templates, not filled paths | `req.route?.path` first `[CODE][TEST]` |
| 12 | An errored request is counted exactly once | Only `requestLogger` records `[TEST: errors.api.test.ts]` |
| 13 | `unsatisfiable` never carries `Retry-After` | `retry_after_ms` left at 0 on that branch `[CODE][TEST]` |
| 14 | The benchmark refuses to report a burst that did not start from a full budget | Explicit throw in `bench-reservation.ts` `[CODE]` |
| 15 | `worst_case` admission count is independent of the output distribution | Not asserted in code; used as a **manual** consistency check on sweep output `[ARTIFACT]` |
| 16 | Every published number has a committed artifact | Convention; `bench/results/` is not gitignored `[CODE: .gitignore]` |
| 17 | **Violated:** the token budget accrues continuously with wall time | §17.1 — commit breaks this |

---

# 21. Dangerous operations

> **WARNING — destroys the local database and Redis AOF.**
> `./scripts/devstack.sh reset` — `rm -rf .devstack`, unrecoverable.

> **WARNING — destroys benchmark evidence.**
> `./bench/repeat.sh …` begins with `rm -rf bench/results/repeat`.
> `./bench/sweep.sh …` overwrites `bench/results/rate-<n>.txt` in place.
> `make clean` removes `bench/results` **entirely**, along with `dist`,
> `coverage` and `node_modules` `[CODE: Makefile:61-62]`.
> These files are the provenance for every number in `README.md`.

> **WARNING — destroys application data if pointed at the wrong Redis.**
> The test harness calls `flushdb` (`src/__tests__/support/redis.ts`). It targets
> DB 15 by default, but honours `REDIS_DB` from the environment. Running
> `npm test` with `REDIS_DB=0` against a live Redis wipes every budget.

> **WARNING — mutates production limits.**
> `POST/PUT/DELETE /api/v1/llm/policies` and `/api/v1/rules` change what every
> tenant is allowed. A `PUT` that lowers `tokensPerMinute` takes effect on the
> writing replica immediately.

> **WARNING — irreversible on the remote.**
> `git push --delete`, and any force-push. The `tokengate` branch was deleted
> this way; it survives only as a bundle outside the repository.

**No path in this repository calls a paid API, allocates a GPU, uploads to an
external service, or touches a production database.** `[CODE]` The only outbound
network calls are to Redis, PostgreSQL, and — from the benchmarks — the local
gateway.

---

# 22. Cost model

| Resource | Cost |
|---|---|
| **API calls** | None. No external service is contacted `[CODE]` |
| **GPU** | None. The service models GPU slots via `maxConcurrency`; it never allocates one |
| **Cloud** | None. Everything runs locally or in CI |
| **CI** | Two jobs per push: `verify` (service containers + full suite + smoke) and `docker` (image build). GitHub-hosted `ubuntu-latest` |
| **Storage** | `bench/results/` is ~52 small text files. `node_modules` and `.devstack` dominate local disk |
| **A full Benchmark A run** | ~12 minutes wall clock: 5 sweeps × 7 rates × 20 s, plus gateway restarts |
| **A full Benchmark B sweep** | ~2 minutes: 5 medians × (150 calibration + 400 burst) requests |

---

# 23. Current state by component

### Stable — relied upon, tested, measured

`src/llm/admission-scripts.ts` (except §17.1) · `src/llm/admission.service.ts` ·
`src/llm/estimator.ts` · `src/algorithms/script-runner.ts` ·
`src/algorithms/token-bucket.ts` · `src/utils/pattern.ts` ·
`src/middleware/auth.ts` · `src/middleware/degraded-mode.ts` ·
`src/middleware/request-logger.ts` · `src/middleware/error-handler.ts` ·
the test suite · `scripts/devstack.sh` · `bench/repeat.sh`

### Active — current, but with known open defects

`src/llm/policy.repository.ts` (§17.2) · `src/routes/admission.routes.ts` (§17.3) ·
`src/services/metrics.service.ts` (§17.4) · `src/app.ts` (§17.6)

### Experimental — implemented, not validated

| Item | Why |
|---|---|
| Redis Cluster support | Hash tags are in place; no cluster has been run |
| `adaptive` reservation in production | Measured only against a synthetic distribution |
| `sloTtftMs` shedding | Correct against the predictor; the predictor itself is an EWMA that degrades to a constant if callers omit `serviceMs` |
| The Docker path | `docker build` runs in CI; `docker compose up` has never been executed on the audit host |

### Blocked

Nothing is blocked on an external dependency. `[INFERRED]`

### Deprecated

Nothing is marked deprecated. `PHASE2.md` was deleted in `f9fb461` because it
described dead code as a delivered feature `[GIT]`.

### Possibly legacy

`src/services/rule-engine.service.ts` — written in the original 2025 style,
functionally current and well tested, but the only file in the tree that has not
been rewritten. The generic HTTP limiter as a whole is peripheral to the
project's thesis and could be argued out of scope; nothing in the repository says
it should be.

### Unknown

Why two branches independently solved the same problem · why the retracted p99
figure was ever produced · whether any mesh/network policy was ever specified for
the unauthenticated data plane.

---

# 24. Technical debt

| Item | Risk | Location |
|---|---|---|
| **Commit path has no refill** | Systematic under-crediting of every tenant | §17.1 |
| Two independent unique-violation handling paths, one of them missing | Inconsistent API contract | `policy.repository.ts` vs `rule.repository.ts` |
| Metric labels sourced from unauthenticated input | Unbounded registry growth | §17.4 |
| `now` supplied by the gateway, not Redis | Clock skew across replicas silently shifts lease expiry | `admission.service.ts:85,181` |
| EWMA with a blunt safety factor instead of a quantile | Overrun rate cannot be configured directly; the repository names this itself | `docs/DESIGN.md` |
| `avg_svc` falls back to a constant when callers omit `serviceMs` | `slo_infeasible` decisions become arbitrary | `admission-scripts.ts:80` |
| Dead branch implying `enabled:false` disables admission | Operator misconfiguration | §17.3 |
| Benchmark artifacts written non-atomically and overwritten in place | Silent corruption of the evidence base | `bench/*.sh` |
| `make clean` deletes `bench/results` | One command destroys all provenance | `Makefile:62` |
| Measured stack ≠ deployed stack (Redis 8 vs 7, PG 18 vs 16, Node 26 vs 22) | Published numbers may not transfer | §12.1 |
| Two version strings hardcoded to `2.0.0` | Health output misidentifies the build | `app.ts`, `health.routes.ts` |
| `@types/uuid` orphaned | Cosmetic | `package.json` |
| No test sends SIGTERM | Graceful shutdown is unverified | — |
| `resolved` map unbounded within a 30 s window | Memory spike under high tenant cardinality | `policy.resolver.ts:41` |

---

# 25. If you are taking over this project

## Day 1

Read, in this order:

1. `src/llm/types.ts` — the whole problem statement is in the header comment
2. `src/llm/admission-scripts.ts` — **this is the implementation**; the
   TypeScript around it is plumbing
3. `docs/DESIGN.md` — why each non-obvious choice was made
4. `README.md` §"Engineering log" — including the two retracted numbers
5. This document, §17

Then run the quick start in §10 and watch a reserve/commit pair land in Redis:

```bash
./scripts/devstack.sh redis-cli --scan --pattern 'llm:{acme|llama-70b}*'
./scripts/devstack.sh redis-cli hgetall 'llm:{acme|llama-70b}:stats'
```

## First week

Understand these five, in order of leverage:

1. `ADMIT_SCRIPT` — especially the constraint ordering (§4.2) and why balances
   are persisted on both paths
2. `COMMIT_SCRIPT` — the three statuses, and §17.1
3. `PolicyResolver` — the cache, the stale-on-error path, and what happens on a
   cold cache during a PostgreSQL outage
4. `guardState` — and which routes it wraps (only `/reserve`)
5. `bench/repeat.sh` — why the spread column exists

Run `npm run verify` and then `./bench/repeat.sh 3 20 250 1000 2000` on an idle
machine. Compare your spread column to `bench/results/repeat-summary.txt`.

## Before modifying core logic

- **Any Lua change:** run `npm test` — the Lua is only covered through real Redis.
  There is no unit test for a script in isolation, by design.
- **Any change to `ADMIT_SCRIPT`'s constraint order:** the order determines which
  reason a caller sees, which determines the HTTP status, which determines what
  client libraries do. Check `STATUS_BY_REASON` and
  `src/__tests__/api/admission.api.test.ts`.
- **Any change to the key layout:** the hash tag must survive, or Redis Cluster
  support is lost silently (it will still work on a single node).
- **Any change to `ttlSeconds`:** invariant #4 — budget keys must outlive the
  longest lease.

## Before running expensive experiments

1. `uptime` — is the host quiet? Anything near the core count invalidates the tail.
2. `cp -r bench/results/repeat bench/results/repeat.$(date +%s)` — `repeat.sh`
   deletes it.
3. Confirm the `shed` column will be zero: budgets must be far above offered load.
4. Confirm you are measuring the code you think — `./scripts/serve.sh restart`
   rebuilds.

## Before publishing or deploying

```bash
npm run verify                      # typecheck, lint, build, 103 tests, coverage gate
npm audit --omit=dev                # expect 0
gitleaks detect --source .          # expect no leaks
docker compose config --quiet       # expect an error naming each unset secret
```

For a deployment specifically: set `NODE_ENV=production` **and**
`CONTROL_PLANE_API_KEY`, put the data plane behind network policy, and decide
`ADMISSION_FAILURE_MODE` deliberately.

---

# 26. Change impact map

### If you change `ADMIT_SCRIPT` or `COMMIT_SCRIPT`

**Affected:** every admission decision; the balance arithmetic; the estimator.
**Must rerun:** `src/__tests__/llm/admission.test.ts`,
`src/__tests__/api/admission.api.test.ts`, `src/__tests__/algorithms/token-bucket.test.ts`.
**Artifacts invalidated:** *all* of `bench/results/` — both benchmarks measure
this code path.
**Also:** the SHA changes, so `SCRIPT LOAD` at boot ships a new body. Rolling
deploys will briefly have two script versions live against one Redis. Nothing in
the repository handles that `[UNKNOWN]`.

### If you change the estimator or `reservationSafetyFactor` defaults

**Affected:** `adaptive` reservation sizing only; `worst_case` is unaffected.
**Must rerun:** `npm run bench:reservation` **and** `./bench/sweep-reservation.sh`.
**Artifacts invalidated:** `bench/results/reservation-*.txt`, and the two
`README.md` tables in §"Worst-case vs adaptive reservation".
**Sanity check:** `worst_case` must still admit exactly 75 at every median.

### If you change the request-path middleware (`app.ts`, `request-logger.ts`)

**Affected:** every request's latency and every metric label.
**Must rerun:** `src/__tests__/api/errors.api.test.ts` (cardinality + single
counting), then `./bench/repeat.sh`.
**Artifacts invalidated:** all of Benchmark A, and `bench/results/logging-ab.txt`.

### If you change `PolicyResolver` or the policy schema

**Affected:** which limits apply; the 30 s propagation window.
**Must rerun:** `src/__tests__/api/control-plane.api.test.ts`,
`src/__tests__/api/admission.api.test.ts`.
**Artifacts invalidated:** none directly — benchmarks write their own policies.
**Also:** `src/database/schema.ts` changes need a migration path; the file is
idempotent DDL (`CREATE TABLE IF NOT EXISTS`) with no versioning `[CODE]`.

### If you change the rule engine or `resolveLimit`

**Affected:** the generic HTTP limiter only. The LLM path does not use it.
**Must rerun:** `src/__tests__/services/rule-engine.test.ts`,
`src/__tests__/api/rate-limit.api.test.ts`.
**Artifacts invalidated:** none.

### If you change `docker-compose.yml` or the `Dockerfile`

**Affected:** the deployment path only.
**Must rerun:** `docker compose config` with and without `.env`; the CI `docker` job.
**Not covered:** CI builds the image but never runs `docker compose up`, so
compose-level regressions are caught only by hand `[CODE: ci.yml:104-110]`.

### If you upgrade Redis or PostgreSQL

**Affected:** everything, and §12.1's caveat gets worse or better.
**Must rerun:** the full suite plus both benchmarks, and record the new versions
in the artifacts.

---

# 27. Result provenance

Every headline number traces to a committed file. The chain:

```text
README.md §Admission decision cost          (the table a reader sees)
        ↓
bench/results/repeat-summary.txt            (median + range + spread, 5 sweeps)
        ↓
bench/results/repeat/run{1..5}-rate-{n}.txt (raw per-sweep output)
bench/results/repeat/load.txt               (host load before each sweep)
        ↓
bench/repeat.sh  →  bench/sweep.sh  →  bench/bench-admission.ts
        ↓
bench/lib/workload.ts  CHAT_WORKLOAD, seed 20260830
        ↓
commit 7e58013 (harness) + 252ae91 (tree state at measurement)
```

```text
README.md §Worst-case vs adaptive reservation
        ↓
bench/results/reservation-default.txt        (the headline table)
bench/results/reservation-median-{90,180,400,900,2000}.txt   (the sweep)
        ↓
bench/sweep-reservation.sh  →  bench/bench-reservation.ts
        ↓
bench/lib/workload.ts  (the ASSUMPTION, not a measurement)
        ↓
commit 7e58013
```

```text
README.md §Engineering log, per-request logging
        ↓
bench/results/logging-ab.txt
        ↓
bench/logging-ab.sh  (SLOW_REQUEST_LOG_MS=0 vs 250, same binary, back to back)
```

## Where provenance breaks

| Break | Detail |
|---|---|
| **The retracted p99 2,538 ms figure** | No artifact survives. The files it came from were overwritten by the re-measurement (`sweep.sh` writes in place). The claim exists only in the engineering log's account of it |
| **Artifacts are not stamped with a commit** | Each file records node version, platform, cores and load average, but **not** the git SHA of the code under test. Matching an artifact to a commit relies on file mtime versus commit date `[INFERRED]` |
| **CPU columns in the README table** | Taken from "a representative sweep", not from the 5-sweep aggregate — `repeat.sh` discards CPU. The README says so `[DOC]` |
| **`worst_case = 75` consistency check** | Performed by eye, not by an assertion |

---

# 28. Sources of truth

| Question | Authoritative file |
|---|---|
| What are the dependency versions? | `package-lock.json` — **not** `package.json` |
| What does a policy default to? | `src/llm/types.ts` `DEFAULT_POLICY`, mirrored in `src/database/schema.ts` column defaults. **Both must change together** |
| What is the database shape? | `src/database/schema.ts` (idempotent DDL, no migration versioning) |
| What configuration exists? | `src/config/index.ts` plus the five direct `process.env` reads listed in §7.1. `.env.example` is documentation and is incomplete (§17.6) |
| What are the measured numbers? | `bench/results/` — `README.md` quotes them |
| What is the project's current state? | `README.md` §"Known limits" and this document |
| What was audited and found? | `SECURITY.md` |
| Which secrets findings are triaged? | `.secrets.baseline` (detect-secrets) and `.gitleaksignore` |
| What does the API return? | The code. `API.md` is accurate except discrepancy #1 in §18 |

**Generated, do not hand-edit:** `dist/`, `coverage/`, `.devstack/`,
`bench/results/*.txt`, `package-lock.json` (edit `package.json` and reinstall).

---

# 29. Open questions

1. **Why does `COMMIT_SCRIPT` not refill?** (§17.1) Deliberate simplification or
   oversight? The scripts' comments are unusually thorough everywhere else, and
   this one is silent — which weakly suggests oversight `[INFERRED]`, but nothing
   confirms it.
2. **What caused the unreproducible p99 2,538 ms measurement?** Never identified.
   Until it is, the current numbers carry an unquantified risk of the same
   mechanism recurring.
3. **Were the two branches (`tokengate` and this one) meant to be reconciled?**
   Neither references the other. Should the archived OpenAI adapter, tokenizer
   and deployment configs be brought forward?
4. **Was any network policy or mesh mTLS ever specified for the unauthenticated
   data plane?** `SECURITY.md` says it "belongs behind network policy" but names
   none.
5. **Is the generic HTTP limiter in scope?** It is fully working and tested but
   orthogonal to the project's thesis. Keeping it costs maintenance; removing it
   deletes ~1,000 lines and 30 tests.
6. **Should `now` come from Redis rather than the gateway?** The clock-skew
   assumption is undocumented.
7. **What is the intended deployment target?** No Kubernetes manifests, no
   Terraform, no cloud references. The Docker compose stack is a local
   development convenience, not a deployment `[INFERRED]`.
8. **Why do CI and Docker pin Redis 7 / PostgreSQL 16 while every measurement was
   taken on Redis 8 / PostgreSQL 18?** No commit or comment explains the choice.

---

# 30. Self-audit

Can a stranger answer these from this document alone?

| # | Question | § |
|---|---|---|
| 1 | What is this project? | 1.1–1.2 |
| 2 | Why is it designed this way? | 1.6, 19 |
| 3 | How do I run it? | 10, 11 |
| 4 | Where do I start reading code? | 25 |
| 5 | What are the inputs and outputs? | 1.2, 16 |
| 6 | Where is configuration? | 7 |
| 7 | Where does data go? | 8, 6.3 |
| 8 | Which experiments are official? | 9 |
| 9 | Which results can I trust? | 9, 27 |
| 10 | How do I reproduce? | 11 |
| 11 | Where is it stuck? | 17, 23, 29 |
| 12 | What must not be changed casually? | 20, 21, 26 |
| 13 | What must I rerun after a change? | 26 |
| 14 | What are the hidden assumptions? | 14.3 |
| 15 | What is the technical debt? | 24 |
| 16 | What is abandoned? | 2.3, 23 |
| 17 | What should be done next? | 29, 24 |
| 18 | How do I validate a change? | 25, 26 |
| 19 | Where do the final numbers come from? | 27 |
| 20 | Could someone take this over tomorrow? | Yes, with the caveats in 29 |

**Remaining dependence on the original author:** questions 1, 2, 3, 6 and 8 in
§29 cannot be answered from the repository. Everything operational can.
