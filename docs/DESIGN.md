# Design notes

Decisions that were not obvious, and what the alternative would have cost.

## Why the whole decision is one Lua script

Refill, compare, deduct, lease. Splitting these across round trips lets two
gateway replicas each read the same remaining balance and both admit, so the
over-admission is proportional to the number of replicas -- and it is worst
exactly when the budget is nearly spent, which is when the limit matters. Redis
runs a script to completion before serving any other command, so the whole
decision is serialised on the shard without any lock the gateway has to hold,
renew, or lose.

The cost is that the decision logic lives in Lua, where it is harder to read and
cannot be unit-tested in isolation. That is why the tests run against a real
Redis: the scripts are the implementation, so testing anything else tests nothing.

## Why expiry is swept inline, not by a background job

Every reservation needs a deadline, because a client that crashes between reserve
and commit would otherwise burn its hold forever.

A sweeper process is the obvious design and the wrong one here. It is another
deployment to run, monitor and elect a leader for; it returns budget on its own
schedule rather than when someone needs it; and it introduces the one race the
protocol most needs to avoid -- refunding a hold at the same moment its owner
commits it, crediting the tenant twice.

Sweeping a bounded batch at the top of the admission script has none of those
properties. It runs inside the same atomic decision, so a concurrent commit
cannot interleave with it. It reclaims budget at the moment a request needs
budget. And it needs no coordination at all, because there is nothing to
coordinate. The batch is bounded so a large backlog degrades latency gradually
rather than stalling one unlucky request behind thousands of deletions.

## Why the balance is allowed to go negative

An overrun -- a caller generating more than it reserved -- is charged at commit as
a negative refund. The balance can drop below zero and the tenant refills out of
the hole before being admitted again.

The alternative, clamping at zero, means the tokens beyond the reservation are
free. That turns underestimating into a strategy: a caller that consistently
overran would get compute it never paid for, and adaptive reservation would be
exploitable by design rather than merely imprecise.

## Why commit is idempotent and reserve is not

Commit is called by a client that has just waited out a slow generation, which is
exactly when its own request times out and gets retried. Charging twice for one
completion is a billing bug that surfaces only under the conditions hardest to
reproduce.

Reserve is deliberately not idempotent. A retried reserve is a genuinely new
request for capacity -- the caller gave up on the first one -- and the first
reservation is released by its lease. Deduplicating reserves would require the
caller to mint an idempotency key it has no reason to have.

## Why the two failure modes differ

`RATE_LIMIT_FAILURE_MODE` defaults to `fail_open`; `ADMISSION_FAILURE_MODE`
defaults to `fail_closed`.

A limiter that returns 500 when Redis blips has made its own availability the
ceiling on the availability of everything it fronts. For ordinary HTTP traffic
the cost of letting requests through unmetered for a few seconds is small, so
failing open is right.

Behind LLM admission is a fixed pool of accelerators. Unmetered traffic there
does not degrade gracefully: it queues, and the queue grows until the backend
collapses and every in-flight request is lost, not just the excess. Refusing is
recoverable in a way that overrunning a GPU fleet is not.

Both are configurable, because the right answer depends on what is downstream,
and both label the response so nothing mistakes a fallback for an enforced
verdict.

## Why policy resolution is cached but budgets are not

Policies are read from Postgres and cached for 30 seconds per resolved
(tenant, model) pair. Budgets are read from Redis on every single decision.

They are different kinds of state. A policy changes when an operator changes it,
which is rare and tolerates seconds of staleness -- and putting a Postgres round
trip on the path of every admission would dominate the latency this service
exists to keep small. A budget changes on every request and cannot be stale by
even one decision without breaking the guarantee.

Writes invalidate the policy cache immediately, so the staleness window applies
to propagation between replicas, not to the replica that took the write.

## Why `worst_case` is still the default

Adaptive reservation admits ~3x as much of a burst from the same budget
(`bench/bench-reservation.ts`), which is a large win. It is not the default
because it is a trade, not an improvement: it guesses low on some fraction of
requests, and whether that fraction is acceptable depends on what the budget is
protecting. A deployment metering a shared GPU pool may prefer the guarantee; one
metering a billing quota probably prefers the throughput.

Defaults should be the choice that cannot surprise anyone.

## Why the estimator is an EWMA and not a quantile

Reserving at, say, the p95 of observed output length would bound the overrun rate
directly, which is the property an operator actually wants to configure. It also
requires keeping a sketch per (tenant, model) and updating it inside the commit
script.

The EWMA needs one float, updates in one line of Lua, and tracks drift in traffic
mix without storing history. The safety factor is a blunt stand-in for the
quantile. This is the clearest known place where the design trades precision for
simplicity, and a t-digest in Redis would be the principled replacement.

## What is not here

**Redis Cluster.** Keys carry hash tags (`llm:{tenant|model}:...`) so every
multi-key script stays within one slot, which is the design constraint that
matters. But only single-node Redis has been run, so cluster support is a claim
about the key layout, not a tested deployment.

**Streaming-aware admission.** Output tokens arrive over seconds. A gateway that
saw the stream could reconcile incrementally rather than in one commit at the end,
which would shrink the window in which a hold is wrong. That requires the gateway
to sit in the data path instead of beside it -- a much larger change in what this
service is.

**Priority classes.** Interactive and batch traffic contend for the same budget
and the same slots. Batch work is exactly what should be shed first under
pressure, and the admission script has the information to do it; it does not.
