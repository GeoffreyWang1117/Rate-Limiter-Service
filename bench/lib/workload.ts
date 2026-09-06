import { seededRandom } from './stats';

/**
 * Synthetic LLM traffic.
 *
 * The shape that matters for admission control is the gap between what callers
 * declare and what they use. Chat traffic has a long-tailed output length --
 * most replies are short, a small fraction run to the ceiling -- while
 * `max_tokens` is set once, defensively, and rarely revisited. A log-normal
 * output length against a fixed declared ceiling reproduces that gap; a uniform
 * distribution would not, and would make adaptive reservation look better than
 * it is by removing the tail that punishes it.
 *
 * These are stand-ins for a real trace, not a claim about any particular
 * deployment. The generator is seeded so a run is reproducible.
 */
export interface WorkloadConfig {
  seed: number;
  /** Median output tokens. */
  outputMedian: number;
  /** Log-space spread. Higher means a heavier tail. */
  outputSigma: number;
  /** Ceiling every caller declares, regardless of what it uses. */
  declaredMaxTokens: number;
  promptMedian: number;
  promptSigma: number;
  /** Milliseconds of service time per output token, before overhead. */
  msPerOutputToken: number;
  /** Fixed time to first token. */
  ttftMs: number;
}

export const CHAT_WORKLOAD: WorkloadConfig = {
  seed: 20260830,
  outputMedian: 180,
  outputSigma: 0.9,
  declaredMaxTokens: 4096,
  promptMedian: 900,
  promptSigma: 0.7,
  msPerOutputToken: 8,
  ttftMs: 120,
};

export interface SyntheticRequest {
  promptTokens: number;
  maxOutputTokens: number;
  /** What generation will actually produce. Unknown to the gateway at reserve time. */
  actualOutputTokens: number;
  /** How long that generation would take on a real backend. */
  serviceMs: number;
}

export class WorkloadGenerator {
  private rand: () => number;

  constructor(private readonly config: WorkloadConfig = CHAT_WORKLOAD) {
    this.rand = seededRandom(config.seed);
  }

  private normal(): number {
    // Box-Muller. Two uniforms in, one standard normal out.
    const u1 = Math.max(this.rand(), Number.EPSILON);
    const u2 = this.rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  private logNormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }

  next(): SyntheticRequest {
    const c = this.config;
    const promptTokens = Math.max(1, Math.round(this.logNormal(c.promptMedian, c.promptSigma)));
    // Callers cannot exceed the ceiling they declared: the backend stops there.
    const actualOutputTokens = Math.max(
      1,
      Math.min(c.declaredMaxTokens, Math.round(this.logNormal(c.outputMedian, c.outputSigma)))
    );
    return {
      promptTokens,
      maxOutputTokens: c.declaredMaxTokens,
      actualOutputTokens,
      serviceMs: Math.round(c.ttftMs + actualOutputTokens * c.msPerOutputToken),
    };
  }

  /** Draws n requests up front, so competing configurations see identical traffic. */
  take(n: number): SyntheticRequest[] {
    return Array.from({ length: n }, () => this.next());
  }
}
