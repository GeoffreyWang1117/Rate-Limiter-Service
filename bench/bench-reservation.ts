/**
 * Benchmark B -- what does it cost to reserve the worst case?
 *
 * The gateway has to hold budget for output it has not seen yet. It can hold the
 * ceiling the caller declared, which can never overrun but strands budget against
 * tokens that are usually never generated; or it can hold an estimate drawn from
 * what the model has actually been producing, which recovers that budget and
 * occasionally guesses low.
 *
 * That is a real trade, so it needs both numbers measured, not just the flattering
 * one:
 *
 *   burst admission  how much of an arriving burst fits in a given budget
 *   overrun rate     how often the estimate was too low, and by how much
 *
 * Method
 *   Both modes see byte-identical traffic: the workload is drawn once from a
 *   seeded generator and replayed against each. Output length is log-normal
 *   against a fixed declared ceiling, which is the shape that makes this trade
 *   exist -- most completions are short, the ceiling is set once and defensively.
 *
 *   Each phase runs against a fresh tenant so it starts from a full budget and
 *   cannot inherit the previous phase's balance or its learned estimate.
 *
 * Run: npx tsx bench/bench-reservation.ts [--url http://127.0.0.1:3055]
 */
import http from 'http';
import { fmt, table } from './lib/stats';
import {
  WorkloadGenerator,
  SyntheticRequest,
  WorkloadConfig,
  CHAT_WORKLOAD,
} from './lib/workload';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = flag('url', 'http://127.0.0.1:3055');
const TOKENS_PER_MINUTE = Number(flag('tpm', '400000'));
const BURST = Number(flag('burst', '400'));
const CALIBRATION = Number(flag('calibration', '150'));

/**
 * Output length is the assumption this benchmark's magnitude rests on, so it is
 * a knob rather than a constant. The advantage adaptive reservation has is a
 * function of how far the declared ceiling sits above what is actually
 * generated; sweeping the median is what turns "3.16x" from a single number
 * into a curve a reader can locate their own traffic on.
 */
const WORKLOAD: WorkloadConfig = {
  ...CHAT_WORKLOAD,
  outputMedian: Number(flag('output-median', String(CHAT_WORKLOAD.outputMedian))),
  outputSigma: Number(flag('output-sigma', String(CHAT_WORKLOAD.outputSigma))),
  declaredMaxTokens: Number(flag('ceiling', String(CHAT_WORKLOAD.declaredMaxTokens))),
};
const MODEL = 'bench-model';
const RUN = Date.now().toString(36);

const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
const url = new URL(BASE);

interface Reply {
  status: number;
  body: any;
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

/**
 * The calibration phase spends real budget, and it has to: the estimator only
 * learns from settled requests. Left alone that contaminates the measurement --
 * at an output median of 180 the 150 calibration requests drain 56% of the
 * budget, so the burst is measured against a half-empty bucket while the
 * benchmark claims a full one, and at a median of 2000 they drain all of it and
 * both modes admit zero. The sweep is what exposed this: an experiment that
 * reports 0 out of 400 for every mode is measuring its own setup.
 *
 * So calibration runs against a budget large enough never to bind, and the
 * policy is tightened to the measured value immediately before the burst.
 * Lowering capacity re-clamps the bucket to the new ceiling on the next refill,
 * which hands the burst a genuinely full budget, while the learned estimator
 * lives under the tenant namespace and survives the policy write.
 */
const CALIBRATION_TPM = 1_000_000_000;

async function putPolicy(
  tenant: string,
  mode: 'worst_case' | 'adaptive',
  tokensPerMinute: number,
  id?: string
): Promise<string> {
  const body = {
    tenantPattern: tenant,
    modelPattern: '*',
    tokensPerMinute,
    requestsPerMinute: 1_000_000,
    // Concurrency and queue are deliberately taken out of play: this experiment
    // is about the token budget, and a concurrency limit binding first would
    // measure something else entirely.
    maxConcurrency: 100_000,
    maxQueueDepth: 1_000_000,
    leaseSeconds: 300,
    reservationMode: mode,
    reservationSafetyFactor: 1.5,
    priority: 8_000,
  };

  const res = id
    ? await request('PUT', `/api/v1/llm/policies/${id}`, body)
    : await request('POST', '/api/v1/llm/policies', body);

  const want = id ? 200 : 201;
  if (res.status !== want) {
    throw new Error(
      `policy for ${tenant} not ${id ? 'updated' : 'created'} ` +
        `(HTTP ${res.status}): ${JSON.stringify(res.body)}`
    );
  }
  return (res.body.data?.id ?? id) as string;
}

const reserve = (tenant: string, w: SyntheticRequest) =>
  request('POST', '/api/v1/llm/reserve', {
    tenant,
    model: MODEL,
    promptTokens: w.promptTokens,
    maxOutputTokens: w.maxOutputTokens,
  });

const commit = (tenant: string, reservationId: string, w: SyntheticRequest) =>
  request('POST', '/api/v1/llm/commit', {
    tenant,
    model: MODEL,
    reservationId,
    promptTokens: w.promptTokens,
    outputTokens: w.actualOutputTokens,
    serviceMs: w.serviceMs,
  });

/**
 * Feeds completed request/response pairs through so the adaptive estimator has
 * something to learn from. Worst-case mode ignores the history but runs the same
 * sequence, so both start the measured phase having seen identical traffic.
 */
async function calibrate(tenant: string, workload: SyntheticRequest[]): Promise<void> {
  for (const w of workload) {
    const res = await reserve(tenant, w);
    if (res.body.decision === 'admit') {
      await commit(tenant, res.body.reservationId, w);
    }
  }
}

interface BurstResult {
  mode: string;
  admitted: number;
  shed: number;
  meanHeldTokens: number;
  meanActualTokens: number;
  overruns: number;
  overrunTokens: number;
}

/**
 * Fires the whole burst before committing any of it, which is what a burst
 * genuinely looks like from the budget's point of view: every request is holding
 * its reservation at the same time.
 */
async function burst(
  tenant: string,
  mode: string,
  workload: SyntheticRequest[]
): Promise<BurstResult> {
  const replies = await Promise.all(workload.map((w) => reserve(tenant, w)));

  let admitted = 0;
  let shed = 0;
  let heldTotal = 0;
  let actualTotal = 0;
  let overruns = 0;
  let overrunTokens = 0;

  const commits: Promise<unknown>[] = [];
  replies.forEach((res, i) => {
    const w = workload[i];
    if (res.body.decision !== 'admit') {
      shed++;
      return;
    }
    admitted++;
    const held = res.body.reservedTokens as number;
    const actual = w.promptTokens + w.actualOutputTokens;
    heldTotal += held;
    actualTotal += actual;
    if (actual > held) {
      overruns++;
      overrunTokens += actual - held;
    }
    commits.push(commit(tenant, res.body.reservationId, w));
  });
  await Promise.all(commits);

  return {
    mode,
    admitted,
    shed,
    meanHeldTokens: admitted ? heldTotal / admitted : NaN,
    meanActualTokens: admitted ? actualTotal / admitted : NaN,
    overruns,
    overrunTokens,
  };
}

async function main(): Promise<void> {
  const generator = new WorkloadGenerator(WORKLOAD);
  const calibrationTraffic = generator.take(CALIBRATION);
  const burstTraffic = generator.take(BURST);

  const actual = burstTraffic.map((w) => w.promptTokens + w.actualOutputTokens);
  const declared = burstTraffic.map((w) => w.promptTokens + w.maxOutputTokens);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  console.log('\nBenchmark B -- worst-case vs adaptive reservation\n');
  console.log(`  budget            ${TOKENS_PER_MINUTE.toLocaleString()} tokens/minute`);
  console.log(`  burst             ${BURST} requests arriving together`);
  console.log(`  declared ceiling  ${WORKLOAD.declaredMaxTokens} output tokens`);
  console.log(
    `  workload          prompt ~${WORKLOAD.promptMedian} tokens, output log-normal ` +
      `(median ${WORKLOAD.outputMedian}, sigma ${WORKLOAD.outputSigma})  [assumption, not a trace]`
  );
  console.log(
    `  per request       ${fmt(mean(declared), 0)} tokens declared, ` +
      `${fmt(mean(actual), 0)} actually used ` +
      `(${fmt((1 - mean(actual) / mean(declared)) * 100, 1)}% of the declaration is never generated)\n`
  );

  const results: BurstResult[] = [];
  for (const mode of ['worst_case', 'adaptive'] as const) {
    const tenant = `bench-${mode}-${RUN}`;
    process.stdout.write(`  ${mode.padEnd(11)} calibrating ... `);
    const policyId = await putPolicy(tenant, mode, CALIBRATION_TPM);
    await calibrate(tenant, calibrationTraffic);

    // Tighten to the budget under test, then confirm the burst really is
    // starting from a full one rather than from calibration's leftovers.
    await putPolicy(tenant, mode, TOKENS_PER_MINUTE, policyId);
    const state = await request(
      'GET',
      `/api/v1/llm/state?tenant=${encodeURIComponent(tenant)}&model=${MODEL}`
    );
    const startingBudget = Number(state.body.tokensRemaining);
    if (!(startingBudget >= TOKENS_PER_MINUTE * 0.99)) {
      throw new Error(
        `${mode}: burst would start from ${startingBudget} of ${TOKENS_PER_MINUTE} tokens. ` +
          `Calibration leaked into the measurement; refusing to report it.`
      );
    }

    process.stdout.write('burst ... ');
    results.push(await burst(tenant, mode, burstTraffic));
    console.log('done');
  }

  const [worst, adaptive] = results;

  console.log('\nhow much of the burst fits in the budget\n');
  console.log(
    table(
      results.map((r) => ({
        mode: r.mode,
        admitted: r.admitted,
        shed: r.shed,
        'admitted %': fmt((r.admitted / BURST) * 100, 1),
        'mean held': fmt(r.meanHeldTokens, 0),
        'mean used': fmt(r.meanActualTokens, 0),
        'held but unused %': fmt(
          (1 - r.meanActualTokens / r.meanHeldTokens) * 100,
          1
        ),
      }))
    )
  );

  console.log('\nwhat adaptive gives up for it\n');
  console.log(
    table(
      results.map((r) => ({
        mode: r.mode,
        overruns: r.overruns,
        'overrun %': fmt((r.overruns / Math.max(1, r.admitted)) * 100, 2),
        'overrun tokens': r.overrunTokens,
        'as % of used': fmt(
          (r.overrunTokens / Math.max(1, r.meanActualTokens * r.admitted)) * 100,
          2
        ),
      }))
    )
  );

  const gain = adaptive.admitted / Math.max(1, worst.admitted);
  console.log(
    `\n  adaptive admitted ${fmt(gain, 2)}x as much of the burst from the same budget,`
  );
  console.log(
    `  and overran on ${adaptive.overruns} of ${adaptive.admitted} admitted requests ` +
      `(${fmt((adaptive.overruns / Math.max(1, adaptive.admitted)) * 100, 2)}%).`
  );
  console.log(
    `  Overruns are charged at commit, so they are paid for -- they are not a way past the budget.\n`
  );

  agent.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
