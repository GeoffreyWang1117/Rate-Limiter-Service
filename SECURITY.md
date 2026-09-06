# Security

## Reporting

Open an issue, or contact the maintainer. There is no bounty.

## What this service assumes about where it sits

The **data plane** (`reserve`, `commit`, `release`, `state`) is unauthenticated by
design. It is meant to be called by an inference gateway inside a trust boundary,
not from the internet, and a tenant name is an identifier rather than a
credential. Exposing it publicly lets anyone who can guess a tenant name spend
that tenant's budget. Put it behind your own authentication if it will be
reachable from outside.

The **control plane** (`/api/v1/llm/policies`, `/api/v1/rules`) is different: it
can raise any tenant's limits to anything, so it requires
`CONTROL_PLANE_API_KEY` and returns 503 rather than serving anonymously when
that is unset under `NODE_ENV=production`. Comparison is constant-time.

CORS is closed unless `CORS_ORIGIN` names origins. It used to default to `*`,
which invited a browser on any origin to reach the unauthenticated data plane.

## Audit

Nine scanner layers plus runtime probes against a running instance, most
recently on 2026-09-06. Static scanning generates hypotheses; nothing is
reported here that was not reproduced against the service.

| layer | tool | result |
|---|---|---|
| JS/TS and multi-language SAST | semgrep | clean |
| Python SAST | bandit | clean (no Python) |
| Secrets, working tree | detect-secrets | clean; 2 audited false positives in `.secrets.baseline` |
| Secrets, git history | gitleaks | clean; see `.gitleaksignore` for two suppressed fingerprints |
| Dependencies | trivy, npm audit | clean; 3 CVEs found and fixed, see below |
| Containers and IaC | trivy, checkov | clean |
| Shell scripts | shellcheck | clean |
| Dockerfile | hadolint | clean |

### Confirmed and fixed

- **Compose supplied a default admin credential.** `docker-compose.yml` set
  `CONTROL_PLANE_API_KEY: ${CONTROL_PLANE_API_KEY:-local-dev-key}` alongside
  `NODE_ENV=production`, which defeated the application's own guard: the key was
  never unset, so the 503 never fired. Reproduced — that key authenticated, and
  a POST with it raised a tenant to 99,000,000 tokens/minute. The secrets now
  have no defaults; compose refuses to start without them.
- **Everything was published on every interface.** Redis without a password,
  PostgreSQL, Prometheus, and Grafana with the password `admin` were all bound to
  `0.0.0.0`. Only the gateway is published now, on loopback unless `GATEWAY_BIND`
  says otherwise, and Redis requires a password.
- **Metric labels were taken from the request URL.** The error handler recorded
  against `req.path`, so anyone who could reach the service could mint unbounded
  Prometheus time series from the 404 path. It also double-counted every error,
  because the request logger already records on response finish.
- **A malformed body was reported as a server fault.** `express.json()` throws a
  `SyntaxError`, which fell through to the generic 500 handler. Clients could not
  act on it and it inflated the 5xx rate. It is a 400 now.
- **Malformed requests were invisible to metrics.** The request logger was
  registered after the body parser, so a parse failure meant its response
  listener was never attached and the request was never counted at all.
- **Unmatched routes were labelled `path=""`** rather than `unmatched`, because
  `??` does not fall through an empty string.
- **A 10MB JSON body limit** on endpoints whose largest legitimate body is a few
  hundred bytes, parsed on the thread that serves every other request. Now 64kb.
- **CI ran with inherited workflow permissions.** Now `contents: read`.
- **No lockfile was committed**, so `npm ci` in the Dockerfile and in CI could
  not run on a fresh clone, and any build that did run resolved its own
  dependency versions rather than a pinned set. A supply-chain review of this
  project was not possible against the repository alone. The lockfile is now
  tracked, which is also what pins the `qs` override below.
- **Two reachable `qs` CVEs.** Express 4 pins `qs` 6.15.3, which carries a
  denial of service through an attacker-controlled `isBuffer` and an array-limit
  bypass. Both sit on the query-string parser, which every request reaches. An
  npm override pins `qs` to 6.16.0; `npm audit --omit=dev` reports 0.
- **One unreachable `uuid` CVE, fixed by deleting the dependency.** The advisory
  covers v3/v5/v6 when a `buf` argument is passed, and this code called v4 with
  no buffer, so it was not reachable. Rather than take a breaking major bump for
  a finding that did not apply, the dependency was dropped: Node has
  `crypto.randomUUID()`, which the admission service was already using.
- **`minimatch` ReDoS advisories are development-only.** They come through the
  build and test toolchain; `npm ls minimatch --omit=dev` is empty, so nothing in
  the runtime image contains it.

### A note on the two scanners

`.secrets.baseline` is detect-secrets' audit record; it stores a SHA1 of every
candidate so a later run can tell a triaged finding from a new one. gitleaks
reads those hex strings as generic API keys and reports them. What is hashed is
two Makefile lines of shell substitution -- variable names in the target that
generates a `.env` of random secrets, not values. They are suppressed in
`.gitleaksignore` by fingerprint rather than by ignoring the file, so a real
secret appearing in the baseline later would still be reported.

### Known and accepted

- The data plane is unauthenticated. See above.
- `bench/` and `scripts/devstack.sh` are development tools. The dev stack binds
  Redis and PostgreSQL to loopback with trust authentication and is not a
  deployment target.

### Not verified

- No staging deployment was probed. Findings above were reproduced against a
  locally running instance built from this source.
- The Docker stack itself was not started during the most recent audit: the
  Docker daemon on the audit machine required privileges the auditor did not
  hold. The compose findings were confirmed by running the application with the
  exact environment the compose file produces.
- Redis Cluster has never been deployed. Keys carry hash tags so multi-key
  scripts stay in one slot, but that has not been exercised.
