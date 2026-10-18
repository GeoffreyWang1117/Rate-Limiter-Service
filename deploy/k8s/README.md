# Kubernetes manifests

What this is, precisely: **nine objects that the Kubernetes API server's own
schemas accept, and that no cluster has ever run.**

`python3 scripts/validate-k8s.py` checks every file against the upstream
*strict* schemas for the target version, which reject unknown fields — a
misspelled `terminationGracePeriodSecond` is silently dropped by the API server
and by every lenient linter, and fails here. That is a real check and it is not
the same as a deployment. There is no cluster on the development host and none
in CI, so nothing below has been observed to schedule, pass a probe, roll, or
survive a node drain. Treat it as a reviewed starting point, not as a
battle-tested deployment.

## Apply

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/          # the rest
```

## Secrets are not in here, on purpose

No `Secret` manifest is committed, not even a template with placeholder values.
A committed template is the thing people copy, fill in, and then commit again;
the repository already carries two suppressed secret-scanner fingerprints from
exactly that genre of file, and an earlier branch was deleted from the remote
over a synthetic key fixture. Create it directly:

```bash
kubectl create secret generic gateway-secrets -n llm-admission \
  --from-literal=control-plane-api-key="$(openssl rand -hex 32)" \
  --from-literal=postgres-user=gateway \
  --from-literal=postgres-password="$(openssl rand -hex 32)" \
  --from-literal=redis-password="$(openssl rand -hex 32)"
```

`CONTROL_PLANE_API_KEY` is not optional in production. The application refuses
to start without it when `NODE_ENV=production`, which is deliberate: the
control plane mutates the policies that govern everyone's budget.

## Decisions worth knowing before you change them

**No CPU limit, a 1-core CPU request.** Node serves HTTP on one thread. A CFS
quota on a single-threaded latency-sensitive server produces throttling that
lands entirely in the tail — the exact quantity this project publishes and is
judged on. Horizontal scaling is the answer to load here, so the protection
against a noisy replica is the request plus the HPA, not a cap.

**HPA at 40% CPU.** Derived from the benchmark, not picked as a round number.
Measured gateway CPU is 30% of a core at 1,000 admission cycles/s, and 1,000 is
the published per-replica capacity — the rate whose tail survived two separate
runs. 2,000 cycles/s measures 50%, and the tail has already widened there. The
target therefore has to sit just above 30% rather than comfortably above it: at
60% the first extra replica would not arrive until roughly 2,400 cycles/s,
which would be this repository publishing one capacity number and configuring
for more than twice it. See the benchmark table in the root README.

**`terminationGracePeriodSeconds: 35` against the application's own 30s
backstop.** The process logs why it gave up before the kubelet kills it.
Inverting the two is how a graceful-shutdown path becomes impossible to debug
in production — the evidence gets killed before it is written.

**A 5-second `preStop` sleep.** Endpoint removal and SIGTERM race: the kubelet
signals the container while kube-proxy and the ingress are still learning the
pod is gone. Without the pause a rollout shows up as a handful of connection
resets.

**The NetworkPolicies are load-bearing, not hardening.** The data plane is
unauthenticated by design — an inference gateway calling `reserve` on every
request cannot afford a second round trip, and what is being protected is
capacity rather than data. That is accepted risk only while something bounds
who can reach it. Before these policies existed, nothing did. Delete
`default-deny` and any pod in the cluster can spend any tenant's budget.

Callers opt in by labelling their namespace:

```bash
kubectl label namespace my-inference-gateway llm-admission.io/client=true
```

## What is not here

- **Redis and PostgreSQL.** The manifests expect a Redis Cluster reachable at
  the seed names in `configmap.yaml` and a PostgreSQL at `postgres:5432`. Both
  are stateful systems whose operation is a project of its own; running them
  from hand-written manifests in the same namespace as the thing that depends
  on them is how people lose data. Use an operator.
- **Ingress / Gateway API.** Deliberately absent. Whether this service is
  exposed outside the cluster at all is a decision about the unauthenticated
  data plane, and the honest default is no.
- **TLS between the gateway and Redis.** `rediss://` is supported by the client
  but untested here.
- **Any form of autoscaling on a signal that matters.** The HPA scales on CPU.
  Admission pressure is better described by shed rate or queue depth, both of
  which the service already exports; a KEDA ScaledObject on
  `llm_admission_decisions_total{outcome!="admit"}` would be the better
  instrument.
