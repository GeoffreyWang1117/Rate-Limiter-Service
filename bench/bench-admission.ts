/**
 * Benchmark A -- what does an admission decision cost?
 *
 * Answers the only latency question that matters for a gateway: how much time
 * does asking permission add to a request, and at what offered rate does that
 * answer stop being acceptable.
 *
 * Method
 *   Open loop. Arrivals are scheduled against absolute wall-clock deadlines, so
 *   when the server slows down the generator keeps offering load rather than
 *   backing off with it. A closed loop of N workers would report a flattering
 *   tail: it stops issuing requests precisely when the system is struggling,
 *   and measures service time while claiming to measure response time.
 *
 *   Budgets are set far above the offered load so nothing is shed. This measures
 *   the cost of the decision, not the cost of a policy rejecting traffic.
 *
 *   Every request runs the full two-phase protocol -- reserve, then commit --
 *   because that is what a real gateway does per inference. The two phases are
 *   timed separately: only reserve sits between the user and their first token.
 *
 * Run: npx tsx bench/bench-admission.ts [--url http://127.0.0.1:3055]
 */
import http from 'http';
import { Latencies, fmt, sleepUntil, table } from './lib/stats';
import { WorkloadGenerator } from './lib/workload';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = flag('url', 'http://127.0.0.1:3055');
const DURATION_S = Number(flag('duration', '12'));
const RATES = flag('rates', '250,500,1000,2000,4000').split(',').map(Number);
const TENANT = 'bench-admission';
const MODEL = 'bench-model';

// Keep-alive with a large socket pool: without it the client spends its time in
// TCP handshakes and reports the connection cost as gateway latency.
const agent = new http.Agent({ keepAlive: true, maxSockets: 2048, maxFreeSockets: 512 });
const url = new URL(BASE);

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function post(path: string, payload: unknown): Promise<Reply> {
  return request('POST', path, payload);
}

function request(method: string, path: string, payload?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        agent,
        host: url.hostname,
        port: url.port,
        path,
        method,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': data.length }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { raw: text } });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

interface RunResult {
  offeredRps: number;
  achievedRps: number;
  completed: number;
  admitted: number;
  shed: number;
  errors: number;
  reserve: ReturnType<Latencies['summary']>;
  commit: ReturnType<Latencies['summary']>;
}

async function runAtRate(targetRps: number, durationS: number): Promise<RunResult> {
  const workload = new WorkloadGenerator();
  const reserve = new Latencies();
  const commit = new Latencies();
  const inFlight: Promise<void>[] = [];

  let admitted = 0;
  let shed = 0;
  let errors = 0;

  const gapMs = 1000 / targetRps;
  const start = Date.now();
  const deadline = start + durationS * 1000;

  for (let i = 0; Date.now() < deadline; i++) {
    // Absolute schedule: arrival i is due at start + i*gap, whatever happened to
    // the requests before it.
    await sleepUntil(start + i * gapMs);

    const w = workload.next();
    inFlight.push(
      (async () => {
        try {
          const t0 = process.hrtime.bigint();
          const res = await post('/api/v1/llm/reserve', {
            tenant: TENANT,
            model: MODEL,
            promptTokens: w.promptTokens,
            maxOutputTokens: w.maxOutputTokens,
          });
          reserve.record(Number(process.hrtime.bigint() - t0) / 1e6);

          if (res.status !== 200 || res.body.decision !== 'admit') {
            shed++;
            return;
          }
          admitted++;

          const t1 = process.hrtime.bigint();
          await post('/api/v1/llm/commit', {
            tenant: TENANT,
            model: MODEL,
            reservationId: res.body.reservationId,
            promptTokens: w.promptTokens,
            outputTokens: w.actualOutputTokens,
            serviceMs: w.serviceMs,
          });
          commit.record(Number(process.hrtime.bigint() - t1) / 1e6);
        } catch {
          errors++;
        }
      })()
    );
  }

  await Promise.all(inFlight);
  const elapsedS = (Date.now() - start) / 1000;

  return {
    offeredRps: targetRps,
    achievedRps: inFlight.length / elapsedS,
    completed: inFlight.length,
    admitted,
    shed,
    errors,
    reserve: reserve.summary(),
    commit: commit.summary(),
  };
}

async function main(): Promise<void> {
  // Budgets far above anything the sweep offers: this run measures the cost of
  // deciding, not the cost of enforcing.
  const policies = await request('GET', '/api/v1/llm/policies');
  const existing = (policies.body.data as { id: string; tenantPattern: string }[]).find(
    (p) => p.tenantPattern === TENANT
  );
  const spec = {
    tenantPattern: TENANT,
    modelPattern: '*',
    tokensPerMinute: 2_000_000_000,
    requestsPerMinute: 100_000_000,
    maxConcurrency: 100_000,
    maxQueueDepth: 1_000_000,
    leaseSeconds: 300,
    priority: 9_000,
  };
  const applied = existing
    ? await request('PUT', `/api/v1/llm/policies/${existing.id}`, spec)
    : await post('/api/v1/llm/policies', spec);

  // Fail loudly. A rejected policy leaves the benchmark running against whatever
  // default happens to be configured, which silently turns a measurement of the
  // admit path into a measurement of the shed path -- and it still prints a
  // plausible-looking table.
  if (applied.status !== 200 && applied.status !== 201) {
    throw new Error(
      `benchmark policy was not applied (HTTP ${applied.status}): ${JSON.stringify(applied.body)}`
    );
  }

  console.log(`\nBenchmark A -- admission decision cost`);
  console.log(`target ${BASE}   ${DURATION_S}s per rate   open loop\n`);

  // Warm up: JIT, connection pool, Redis script cache. Discarded.
  process.stdout.write('  warming up ... ');
  await runAtRate(200, 3);
  console.log('done\n');

  const results: RunResult[] = [];
  for (const rate of RATES) {
    process.stdout.write(`  ${String(rate).padStart(5)} req/s ... `);
    const result = await runAtRate(rate, DURATION_S);
    results.push(result);
    console.log(`done  (${result.admitted} admitted, ${result.shed} shed)`);
    if (result.shed > result.completed * 0.01) {
      console.warn(
        `    warning: ${result.shed} requests were shed. This run is measuring the ` +
          `reject path, not the admit path -- check the benchmark policy.`
      );
    }
  }

  console.log('\nreserve latency (ms) -- the phase that sits between a user and their first token\n');
  console.log(
    table(
      results.map((r) => ({
        'offered rps': r.offeredRps,
        'achieved rps': fmt(r.achievedRps, 0),
        n: r.reserve.count,
        p50: fmt(r.reserve.p50),
        p95: fmt(r.reserve.p95),
        p99: fmt(r.reserve.p99),
        'p99.9': fmt(r.reserve.p999),
        max: fmt(r.reserve.max),
        admitted: r.admitted,
        shed: r.shed,
        errors: r.errors,
      }))
    )
  );

  console.log('\ncommit latency (ms) -- off the critical path, after generation finishes\n');
  console.log(
    table(
      results.map((r) => ({
        'offered rps': r.offeredRps,
        n: r.commit.count,
        p50: fmt(r.commit.p50),
        p95: fmt(r.commit.p95),
        p99: fmt(r.commit.p99),
        max: fmt(r.commit.max),
      }))
    )
  );

  console.log(
    `\nnode ${process.version}  platform ${process.platform}  cpus ${require('os').cpus().length}` +
      // Recorded because its absence made an earlier discrepancy undiagnosable:
      // a sweep on a shared machine produced a p99 three orders of magnitude
      // worse than the same code on the same host later, and nothing in the
      // artifact said how busy the box had been. A tail latency measured under
      // unknown contention is not a measurement of this service.
      `\nload average ${require('os').loadavg().map((n: number) => n.toFixed(2)).join(' ')}` +
      `  (a 1-minute figure near or above the core count means this run was contended)`
  );
  console.log('single host, loopback: no network between client, gateway and Redis.\n');
  agent.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
