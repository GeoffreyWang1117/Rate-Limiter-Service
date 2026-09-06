# LLM Admission Gateway

Token-aware admission control for LLM inference, on Redis and PostgreSQL.

A conventional API rate limiter charges every request one unit and decides once,
at arrival. Neither half of that holds for inference traffic, so this service
implements a three-phase protocol instead — reserve, commit, expire — and
measures what that protocol costs.

```
  reserve   hold budget for a request whose output length is not yet known
  commit    reconcile against what generation actually consumed
  expire    reclaim holds whose owner never came back
```

---

## Why LLM traffic needs a different limiter

**Cost is tokens, not requests, and it varies by three orders of magnitude.** A
one-line completion and a 200k-token context are one request each. A limiter
counting requests lets a handful of large prompts saturate a GPU fleet while the
request counter still reads nearly empty.

**The dominant part of that cost is unknown at admission time.** Prompt tokens
can be counted. Output tokens are only known when generation stops. The gateway
must commit to a decision before it can know what it is deciding about.

That forces the protocol. Hold an estimate up front, reconcile when the truth
arrives — and, because any client can crash between those two points, put a lease
on the hold. Without the lease, every crashed request permanently burns a slice
of its tenant's budget, and the tenant's effective quota decays toward zero with
no error anyone can point at: every individual decision was correct.

**Requests occupy a GPU for seconds, not milliseconds.** So concurrency is a
separate constraint from rate, and a request can be well inside its token budget
and still have to wait. When the predicted wait already exceeds the caller's
deadline, admitting it is strictly worse than shedding it — it occupies a slot for
the whole wait and delivers a response nobody is still waiting for.

---

## The protocol

```
   client                     gateway                        Redis
     │                           │                             │
     │─ reserve ────────────────>│                             │
     │  prompt=900, max=4096     │─ EVALSHA admit ────────────>│  one script:
     │                           │                             │   sweep expired leases
     │                           │                             │   refill tpm + rpm
     │<─ admit, reservationId ───│<─ decision ─────────────────│   check budget,
     │   reserved=1724           │                             │     concurrency, SLO
     │                           │                             │   deduct + lease
     │                           │                             │
     │─── inference happens elsewhere; 900 in, 210 out ────────│
     │                           │                             │
     │─ commit ─────────────────>│                             │
     │  prompt=900, output=210   │─ EVALSHA commit ───────────>│   refund 1724-1110
     │<─ refunded=614 ───────────│                             │   drop lease
     │                           │                             │   update estimators
```

Every phase is a single Lua script. Splitting refill / compare / deduct across
round trips would let two gateway replicas each observe the same remaining budget
and both admit, over-admitting by the number of replicas. Redis runs a script to
completion before serving any other command, so each decision is serialised on
the shard.

Expiry is swept on the admission path — a bounded batch per call — rather than by
a background job. A sweeper is another process to deploy, monitor and elect a
leader for, and it returns budget on its own schedule instead of at the moment
someone needs it.

### Shed reasons map to distinct status codes

Collapsing every rejection into `429` tells a client to retry when retrying is
hopeless, and tells a proxy that a saturated backend is a client-side quota
problem.

| Reason | Status | Meaning |
|---|---|---|
| `tpm_exhausted` | 429 | Token budget spent; `Retry-After` says when it refills |
| `rpm_exhausted` | 429 | Request budget spent |
| `queue_full` | 503 | Concurrency and queue both full — server capacity, not client quota |
| `slo_infeasible` | 503 | A slot will free up, but not before the caller's deadline |
| `unsatisfiable` | 400 | Larger than the tenant's entire budget; no `Retry-After`, retrying can never work |

---

## Measured behaviour

Every number below came out of the benchmarks in `bench/`, run against a real
gateway process, a real Redis and a real PostgreSQL. Nothing is projected from a
smaller run and nothing is copied from another system's published figures. The
raw output of each run is committed under `bench/results/`, so every table here
can be checked against the artifact it was read from.

Two of these tables are not the same kind of claim, and the difference matters:

| | what varies | what the number depends on |
|---|---|---|
| **Admission decision cost** | offered rate | the real service. Request *shape* barely moves a latency that is dominated by one Redis round trip |
| **Worst-case vs adaptive reservation** | reservation policy | the real service **and an assumed output-length distribution**. The mechanism is measured; the magnitude is conditional on that assumption |

There is no LLM behind this gateway in either benchmark, and there is no
simulated gateway in either. The backend is never called: admission decides
before generation starts, and `commit` reports what generation produced. The
benchmark supplies those reports itself, which is what lets the second table
sweep output-length assumptions that no single real trace would contain.

### Admission decision cost

One replica, open-loop load, full `reserve` + `commit` cycle per request. Budgets
set far above the offered rate, so this measures the cost of deciding rather than
the cost of a policy rejecting traffic.

**Five sweeps**, reported as the median across runs with the range beside it. A
single draw is not a measurement here. Consecutive sweeps of the same code on the
same host put 2,500 cycles/s at 14.9ms and then 38.8ms, and once had 3,000 come
out better than 2,500 — which cannot be a property of the service. The spread
column is what says whether a number is one.

| offered cycles/s | achieved | p50 (ms) | p95 (ms) | p99 (ms) | p99 range | p99 spread | gateway CPU | Redis CPU |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 250 | 250 | 0.43 | 0.55 | 0.70 | 0.65–0.71 | 1.1x | 10% | 0% |
| 500 | 500 | 0.41 | 0.52 | 0.61 | 0.59–0.63 | 1.1x | 20% | 0% |
| 1000 | 1000 | 0.44 | 0.59 | 0.73 | 0.71–0.89 | 1.3x | 30% | 10% |
| 1500 | 1500 | 0.47 | 0.70 | 1.09 | 0.91–2.51 | 2.8x | 50% | 10% |
| 2000 | 2000 | 0.63 | 0.91 | 1.48 | 1.44–6.05 | 4.2x | 60% | 20% |
| 2500 | 2499 | 0.72 | 1.30 | 6.91 | 2.87–29.01 | **10.1x** | 70% | 20% |
| 3000 | 2999 | 0.72 | 2.08 | 9.55 | 3.23–17.99 | **5.6x** | 80% | 30% |

Latency is of the `reserve` call, the phase that sits between a user and their
first token. CPU is percent of a single core, from a representative sweep; unlike
the tail it repeats closely across runs. Host load average stayed between 4.0 and
5.8 on 32 cores throughout, and is recorded in each artifact.

**Reading it.** One replica holds p99 **under 1ms to 1,000 admission cycles/s**
with the tail repeating to within 1.3x across sweeps — 2,000 HTTP requests/s,
since each cycle is a reserve and a commit. It holds under 1.5ms to 2,000, though
the spread has already widened to 4x there. From 2,500 the spread reaches 10x and
the median tail moves by more between two runs of the same binary than it does
between 250 and 2,000 cycles/s.

**So the capacity claim is 1,000 cycles/s, not 3,000.** The service still serves
2,999 of 3,000 offered, and quoting that would look better. But above ~2,000 this
measurement stops describing the service and starts describing a shared machine,
and a tail latency measured under unknown contention is not a number to design
against. Someone with a quiet host should re-run it; the harness reports the
spread precisely so that judgement is theirs and not buried.

**Where the ceiling is.** Redis never exceeds 30% of one core, and
`redis-benchmark` on the same host sustains ~85k ops/s, so Redis is nowhere near
the constraint. Node serves HTTP on one thread, and gateway CPU tracks offered
load linearly. Capacity therefore comes from adding replicas, not from a bigger
machine — which is what a stateless gateway with all its state in Redis should
do. The shared budget stays correct across replicas because every decision is a
single atomic script.

```bash
./bench/sweep.sh 20 250 500 1000 1500 2000 2500 3000   # one sweep
./bench/repeat.sh 5 20                                  # the table above
```

### Worst-case vs adaptive reservation

The gateway has to hold budget for output it has not seen. It can hold the
ceiling the caller declared — which can never overrun, but strands budget against
tokens that are usually never generated — or an estimate from what the model has
actually been producing, with a safety margin.

**The assumption this rests on.** Prompts ~900 tokens, output log-normal with a
median of 180, every caller declaring the same 4096-token ceiling. That is an
input, not a finding: it is a stand-in for a real trace, chosen because chat
traffic is long-tailed and `max_tokens` is set once, defensively, and rarely
revisited. It follows arithmetically that 72% of each declaration goes
unused — that number describes the assumption, and no traffic was measured to
obtain it. Everything below is a real run of the real gateway driven by it.

400 requests arrive together against a 400,000 token/minute budget:

| mode | admitted | admitted % | mean held | mean used | held but unused |
|---|---:|---:|---:|---:|---:|
| `worst_case` | 75 | 18.8% | 5341 | 1471 | 72.5% |
| `adaptive` | 230 | **57.5%** | 1739 | 1516 | 12.9% |

| mode | overruns | overrun rate | overrun tokens | as % of tokens used |
|---|---:|---:|---:|---:|
| `worst_case` | 0 | 0% | 0 | 0% |
| `adaptive` | 29 | 12.6% | 6372 | **1.83%** |

Adaptive reservation admits **3.07x** as much of this burst from the same budget.
It pays for that by guessing low on 12.6% of requests — but an overrun is charged
at commit, so it is paid for, not a way past the budget. Whether that rate is
acceptable is a deployment's call, which is why it is a per-policy setting rather
than a hardcoded default.

**How much of that survives a different assumption.** The advantage is a function
of the gap between what callers declare and what they use, so reporting one
number from one assumed distribution would present a modelling choice as a
result. Sweeping the assumed output median, ceiling held at 4096:

| assumed output median | unused declaration | `worst_case` | `adaptive` | advantage | overrun rate |
|---:|---:|---:|---:|---:|---:|
| 90 | 74.3% | 75 | 267 | **3.56x** | 12.7% |
| 180 | 72.0% | 75 | 230 | **3.07x** | 12.6% |
| 400 | 66.2% | 75 | 174 | **2.32x** | 12.1% |
| 900 | 54.0% | 75 | 112 | **1.49x** | 9.8% |
| 2000 | 35.0% | 75 | 74 | **0.99x** | 0% |

The honest reading is the last row: once callers declare close to what they use,
adaptive reservation buys nothing, and its overrun risk is no longer worth
carrying. The mechanism is worth having only in the regime where declarations are
loose — which is the common one, but it is a property of the traffic and should
be checked against a deployment's own before the mode is switched on.

`worst_case` admitting exactly 75 in every row is the check that the sweep is
measuring what it claims: that mode reserves the declared ceiling and ignores
what is generated, so its admission count *cannot* depend on the output
distribution. An earlier version of this benchmark reported it varying from 42
down to 0, which is what led to finding that the calibration phase was draining
the budget before the measured burst began.

```bash
npm run bench:reservation          # the table above
./bench/sweep-reservation.sh       # the sensitivity sweep
```

### Environment

Both benchmarks: Node v26.7.0, Linux, 32 cores, Redis 8.10.1 and PostgreSQL 18
on the same host over loopback. No network between client, gateway and Redis, so
these are floor latencies — a real deployment adds a network hop to Redis. The
workload generator is seeded, so runs are reproducible.

---

## Quick start

### Without Docker

The dev stack runs a real Redis and a real PostgreSQL from a conda environment —
no container runtime, no root.

```bash
conda create -y -n ratelimiter -c conda-forge redis-server postgresql

npm install
./scripts/devstack.sh up          # Redis on :6399, PostgreSQL on :55432
npm run build
source scripts/devstack.env.sh && node dist/scripts/migrate.js up
./scripts/serve.sh start          # gateway on :3055
```

`./scripts/devstack.sh {up|down|status|reset|psql|redis-cli}` manages it; data
lives in `.devstack/`.

### With Docker

```bash
make docker-secrets               # writes .env with generated secrets
docker compose up -d --build      # gateway :3000, Prometheus :9091, Grafana :3001
```

The compose file declares its four secrets as `${VAR:?}`, so the stack refuses to
start until `.env` exists rather than falling back to a default. It used to carry
`CONTROL_PLANE_API_KEY: ${CONTROL_PLANE_API_KEY:-local-dev-key}`, which defeated
the application's own guard: the app returns 503 from the control plane when the
key is unset under `NODE_ENV=production`, and the default meant it was never
unset. `docker compose up` produced a production gateway whose admin credential
was a string published in this repository. Only the gateway's port is published,
and it binds to loopback unless `GATEWAY_BIND` says otherwise; Redis, Postgres,
Prometheus and Grafana are reachable only from inside the network.

Migrations run as a one-shot job that must succeed before the gateway starts,
rather than from inside the app — otherwise every replica races to apply the same
DDL on each rollout.

### Walk the protocol

```bash
# A policy for one tenant
curl -X POST localhost:3055/api/v1/llm/policies -H 'Content-Type: application/json' -d '{
  "tenantPattern": "acme", "modelPattern": "*",
  "tokensPerMinute": 5000, "requestsPerMinute": 100,
  "maxConcurrency": 2, "maxQueueDepth": 2, "priority": 500
}'

# Reserve
curl -X POST localhost:3055/api/v1/llm/reserve -H 'Content-Type: application/json' -d '{
  "tenant": "acme", "model": "llama-70b", "promptTokens": 500, "maxOutputTokens": 2000
}'
# -> {"decision":"admit","reservationId":"...","reservedTokens":2500,"tokensRemaining":2500,...}

# Commit what generation actually used; the rest comes back
curl -X POST localhost:3055/api/v1/llm/commit -H 'Content-Type: application/json' -d '{
  "tenant": "acme", "model": "llama-70b", "reservationId": "<id>",
  "promptTokens": 500, "outputTokens": 80, "serviceMs": 1400
}'
# -> {"status":"committed","refundedTokens":1920,"tokensRemaining":4420}

curl 'localhost:3055/api/v1/llm/state?tenant=acme&model=llama-70b'
```

---

## API

### Data plane

| Method | Path | |
|---|---|---|
| POST | `/api/v1/llm/reserve` | Hold budget. Returns a `reservationId` when admitted |
| POST | `/api/v1/llm/commit` | Reconcile actual usage. **Idempotent** |
| POST | `/api/v1/llm/release` | Abandon a reservation that produced nothing |
| GET | `/api/v1/llm/state` | Live budget and in-flight count, consuming nothing |

Commit is idempotent because it is a network call made by a client that has just
waited out a slow generation — exactly when its own request times out and gets
retried. A non-idempotent commit would bill that completion twice, only under the
conditions hardest to reproduce.

The generic HTTP limiter is still here for non-LLM traffic:
`POST /api/v1/check-rate-limit`, `/reset`, `/stats`, with token bucket, sliding
window and fixed window.

### Control plane

`/api/v1/llm/policies` and `/api/v1/rules` — full CRUD, gated by
`CONTROL_PLANE_API_KEY`. Unset in development leaves them open; unset with
`NODE_ENV=production` makes them return 503 rather than silently accepting
anonymous writes, because this API can raise any tenant's limits to anything.

Policies match on glob patterns with a priority, so a deployment can express
"everyone gets this, except tenant acme, except acme on the 70b model" without
enumerating the cross product.

Full request and response shapes: [API.md](API.md).

---

## Operations

### Configuration

| Variable | Default | |
|---|---|---|
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | Counter state |
| `POSTGRES_*` | see `.env.example` | Policy storage |
| `CONTROL_PLANE_API_KEY` | unset | Gates policy and rule writes |
| `RATE_LIMIT_FAILURE_MODE` | `fail_open` | Generic limiter when Redis is unreachable |
| `ADMISSION_FAILURE_MODE` | `fail_closed` | LLM admission when Redis is unreachable |
| `COMMIT_IDEMPOTENCY_TTL` | `300` | How long a settled reservation is remembered |
| `SLOW_REQUEST_LOG_MS` | `250` | Above this, a request gets its own log line |

The two failure modes differ deliberately. A limiter that returns 500 during a
Redis blip has made itself a hard dependency of everything it fronts, so the
generic path fails open — but behind LLM admission is a fixed pool of
accelerators, where admitting unmetered traffic does not degrade gracefully, it
queues until the backend collapses. Either way the response is labelled
`degraded`, because quietly returning `allowed: true` during an outage is how a
limiter comes to look healthy while enforcing nothing.

### Metrics

`/metrics`, Prometheus format. Beyond the usual counters:

| Metric | Why it matters |
|---|---|
| `llm_admission_decisions_total{outcome}` | `outcome` is the binding constraint on a shed, so a spike names its own cause |
| `llm_tokens_reserved_total` / `llm_tokens_worst_case_total` | Ratio is how much budget adaptive reservation is recovering |
| `llm_lease_reclaims_total` | Sustained non-zero means clients are dying between reserve and commit |
| `llm_overrun_tokens_total` | Under `worst_case`, non-zero means `max_tokens` is not enforced upstream |
| `rate_limiter_degraded_responses_total` | Any non-zero rate means decisions are not being enforced |
| `rate_limiter_api_latency_seconds` | Labelled by route template, not path — labelling by path mints a series per id |

### Health

`/health` reports both dependencies. `/health/ready` fails when Redis is
unreachable so a load balancer stops routing to a replica that cannot decide
anything. `/health/live` deliberately checks nothing external: a liveness probe
that fails on a dependency outage makes the orchestrator restart every healthy
replica in the middle of that outage.

---

## Development

```bash
npm run verify     # typecheck, lint, build, test with coverage
npm test           # 103 tests; needs ./scripts/devstack.sh up
```

**Tests run against a real Redis and a real PostgreSQL, never mocks.** Every
property worth checking here — fractional token accrual, TTL arithmetic,
atomicity under concurrency, Lua number coercion, the SQL the repositories
actually emit — lives inside those servers. A mocked `eval` can only confirm that
the arguments passed were the arguments intended, which restates the
implementation instead of testing it. CI provides them as service containers.

103 tests, 82% statement coverage. CI also boots the compiled artifact and drives
a real admission decision through it, because an in-process Express app cannot
catch a broken entrypoint.

---

## Engineering log

Several of the defects below were found by measuring rather than by testing,
which is the reason the benchmarks exist. Two of them were in the benchmarks, and
two published numbers did not survive being re-measured. Those are kept here
rather than quietly corrected, because a performance claim that was wrong once is
the most useful thing a reader can know about how the rest were produced.

**The admission table could not be reproduced.** The originally published figures
had p99 at 2,538ms for 2,000 cycles/s and put the safe operating point at 1,000.
Re-measured on the same host from a cold gateway against a Redis holding 222,000
keys, the same code gives 1.48ms — three orders of magnitude apart, with the same
request count, no shedding and no errors, so it was doing the same work. The
cause was never identified. What made it undiagnosable is that the artifact
recorded the node version, the platform and the core count, but nothing about how
busy the machine had been, and this is a shared workstation.

Two things changed as a result. The harness now records the host load average in
every run, and the reported table is the median of five sweeps with the range and
the max/min spread beside it, so a number that moves between runs is visible as
one. That turned out to matter immediately: the spread is 1.1x at 250 cycles/s
and 10.1x at 2,500, which is the difference between a measurement and a draw.

**A benchmark was measuring its own setup.** The reservation experiment
calibrates the estimator by pushing 150 completed requests through the tenant
before the measured burst, and those requests spend real budget from the same
bucket the burst is then judged against. At the documented workload that drained
56% of the budget before the measurement started, so the published admission
counts were taken against a half-empty bucket while the benchmark's own
documentation claimed a full one. It surfaced only when the workload was swept:
at a longer assumed output length calibration consumed the entire budget and both
modes admitted 0 of 400, which is not a result about reservation policy. The
give-away in the corrected data is that `worst_case` now admits exactly 75 at
every point on the sweep — it reserves the declared ceiling and ignores what is
generated, so its count *cannot* depend on the output distribution, and the old
numbers varying from 42 down to 0 were impossible on their face. Calibration now
runs against a budget too large to bind and the policy is tightened immediately
before the burst; the benchmark asserts the starting balance is full and refuses
to report a run where it is not. The corrected headline is 3.07x rather than the
3.16x previously published, and it repeats identically across runs, where the
contaminated version drifted between 120 and 121.

**Token bucket lost fractional refill.** The bucket accrued
`floor(elapsed × rate)` tokens and advanced its clock to `now` on every admitted
call, discarding the sub-token remainder each time. At 1.5 req/s against a
1 token/s refill, `floor(0.667)` is 0 — so the bucket never refilled while it
still held tokens, drained ~3x too fast, and returned 429 to traffic inside its
configured budget. Measured against a corrected implementation on the same load:
20% of the configured budget was being rejected. Now carries a fractional balance
in Redis; the regression test is calibrated so it fails on the old code.

**Per-request access logging cost most of the benefit of a core.** The request
logger wrote a structured info line for every request. Measured as a controlled
A/B — same binary, same load, back to back, differing only in whether each
request emits a line — at 2,500 cycles/s over four runs:

| arm | CPU (% of one core) | log lines per 20s run |
|---|---|---:|
| a line per request | 103, 97, 98, 98 | 101,203 |
| histogram (current) | 91, 91, 89, 89 | 1 |

Serialisation and the write land on the same thread that serves requests, so the
logger competes directly with the work it is describing. It was replaced with a
latency histogram plus lines for failures and genuine outliers only.

An earlier version of this note claimed a 205x improvement in p99. That number
came from the same pair of runs as the admission table above, and it does not
survive re-measurement: across four A/B pairs the p99 of the two arms overlap
(239, 6.7, 21.4, 7.4 against 10.2, 17.6, 17.9, 5.0), because at this rate the
tail moves more between runs of one arm than it does between arms. The CPU
difference and the log volume are consistent in every run; the tail-latency win
is not measurable on this host and is no longer claimed. The change is still
right — 101,203 lines per twenty seconds is a real cost in CPU, disk and
ingestion — but it is worth less than it was advertised as.

**The idempotency ledger was unbounded.** Settled reservations were recorded as
fields in a per-tenant hash. Hash fields have no individual TTL, so the ledger
grew with throughput for the whole life of the hash — a benchmark run left 218k
fields under a single tenant, directly observed in Redis. Nothing bounded it but
the tenant going idle. Now one key per reservation with its own expiry, sized to
a client's
retry horizon rather than a lease lifetime.

**The rule engine was unreachable.** Rule storage, priority ordering, pattern
matching and a full CRUD API existed and were exercised; nothing on the decision
path ever called `findMatchingRule`. Every configured rule was inert and the
service silently applied its compiled-in defaults. Nothing failed — which is what
made it hard to see. Now resolved on the check path, with the governing rule
returned in the response and in an `X-RateLimit-Policy` header, so a 429 is
attributable to the rule that caused it.

**`KEYS` on the data path.** Fixed-window `reset()` and `getStats()` discovered
keys with `KEYS rate_limit:fixed_window:<key>:*` — an O(N) scan of the entire
keyspace that blocks the Redis event loop for every other tenant on the shard.
Window keys are now derived arithmetically.

**Glob patterns were compiled as partial regexes.** The matcher escaped dots and
no other metacharacter, so an operator pattern containing `+`, `(` or `|` was
interpreted rather than matched — applying the wrong limit to traffic it was
never written for.

**Check-then-insert on a unique constraint.** Rule creation read by name and then
inserted, so two concurrent creates both saw no existing row and the loser
surfaced a raw driver error as a 500. The constraint now decides, and the
conflict is reported as 409.

Also: the service did not compile (14 type errors, so it had never once been
started); its three test suites were two that failed to compile and eight
`expect(true).toBe(true)` placeholders at 0% coverage; Prometheus scraped a port
nothing listened on and Redis directly over RESP; the control plane was
unauthenticated; and the documented performance figures — `P99 < 10ms`,
`100K+ req/s`, `99.99% uptime` — were written for a service with no benchmark
code that could not be built.

The last of those is why every number in this README carries the command that
reproduces it, and why the raw output of every run is committed under
`bench/results/` rather than ignored.

**A fresh clone could not be built.** `package-lock.json` was in `.gitignore`
while both the Dockerfile and CI run `npm ci`, which refuses to install without a
lockfile. Every build that did succeed did so from a lockfile that existed only
on someone's laptop, resolving its own dependency versions. Verified by running
`npm ci` against a `git archive` of HEAD: `EUSAGE`. The lockfile is committed.

**Found by a security audit, all reproduced against a running instance.** The
compose file supplied `local-dev-key` as a default `CONTROL_PLANE_API_KEY`
alongside `NODE_ENV=production`, which defeated the application's own guard: that
key authenticated and raised a tenant to 99,000,000 tokens/minute. Redis without
a password, PostgreSQL, and Grafana with the password `admin` were all published
on every interface. CORS defaulted to `*` in front of an unauthenticated data
plane. The error handler labelled metrics with `req.path`, so a stranger
requesting random URLs could mint unbounded Prometheus series, and it
double-counted every error. A malformed JSON body was reported as a 500 and,
because the request logger was registered after the body parser, was never
counted at all. The body limit was 10MB on endpoints whose largest legitimate
body is a few hundred bytes. `SECURITY.md` has the reproductions.

---

## Known limits

- **One process, one core.** Throughput scales with replicas, not with cores on
  one box. Node clustering would multiply single-host capacity but needs a shared
  metrics registry across workers; for a stateless gateway, replicas are the
  normal answer.
- **Benchmarks are single-host over loopback.** Real deployments add a network
  hop to Redis, which will dominate the sub-millisecond p50 reported here.
- **No production trace was available.** Output lengths in the reservation
  benchmark come from a log-normal distribution chosen to resemble chat traffic,
  not from a captured workload, and the size of adaptive reservation's advantage
  follows from that choice. This is why that result is reported as a sweep over
  the assumption rather than as a single number: the mechanism and the overrun
  accounting are measured, the magnitude is conditional. Anyone evaluating the
  mode should re-run the sweep against their own declared-versus-used ratio.
- **No LLM is behind the gateway in any benchmark.** Admission decides before
  generation begins and `commit` reports what generation produced, so the
  measurements cover the admission path and the accounting, not end-to-end
  serving. Time-to-first-token as a user experiences it is not measured here.
- **Adaptive reservation tracks one EWMA per model**, not per prompt shape. A
  tenant whose traffic mixes short chat and long summarisation gets an estimate
  between the two. Per-route or per-prompt-length estimators would tighten it.
- **No Redis Cluster deployment has been tested.** Keys carry hash tags so every
  multi-key script stays within one slot, but only single-node Redis has been run.
- **`sloTtftMs` is enforced against a predicted wait**, derived from an EWMA of
  observed service time and current queue depth. It is a queueing estimate, not a
  guarantee.

## License

MIT
