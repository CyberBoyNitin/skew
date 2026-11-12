import { analyze, differenceFingerprint, severityFor, signature } from "./core.ts";
import { ddmin } from "./minimize.ts";
import { promptOf, probeWithSegments } from "./probe.ts";
import type { Probe } from "./probe.ts";
import { RunnerError } from "./runners.ts";
import { Semaphore } from "./semaphore.ts";
import type {
  DivergenceVerdict,
  Finding,
  Run,
  Runner,
  RunStats,
  UnstableGroup,
} from "./types.ts";
import { VERSION } from "./version.ts";

export interface HarnessOptions {
  probes: Probe[];
  stacks: Runner[];
  trials?: number;
  minStability?: number;
  minimize?: boolean;
  maxChecks?: number;
  seed?: number;
  origin?: string;
  version?: string;
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  retryMaxDelayMs?: number;
}

interface UnstableAccumulator {
  stackA: string;
  stackB: string;
  probes: number;
  exampleProbe: string;
  stabilityA: number;
  stabilityB: number;
}

export class Harness {
  private readonly probes: Probe[];
  private readonly stacks: Runner[];
  private readonly trials: number;
  private readonly minStability: number;
  private readonly minimize: boolean;
  private readonly maxChecks: number;
  private readonly seed: number;
  private readonly origin: string;
  private readonly version: string;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly semaphore: Semaphore;

  private readonly stats: RunStats = {
    calls: 0,
    errors: 0,
    retries: 0,
    minimizeChecks: 0,
  };
  private readonly errorSamples: string[] = [];
  private readonly cache = new Map<string, string[]>();
  private readonly probesById = new Map<string, Probe>();

  constructor(options: HarnessOptions) {
    if (options.stacks.length < 2) {
      throw new Error("skew needs at least two stacks to compare");
    }
    if ((options.trials ?? 3) < 1) {
      throw new Error("trials must be at least 1");
    }
    if ((options.retries ?? 2) < 0) {
      throw new Error("retries must be zero or greater");
    }

    this.probes = options.probes;
    this.stacks = options.stacks;
    this.trials = options.trials ?? 3;
    this.minStability = options.minStability ?? 0.8;
    this.minimize = options.minimize ?? true;
    this.maxChecks = options.maxChecks ?? 30;
    this.seed = options.seed ?? 0;
    this.origin = options.origin ?? "live";
    this.version = options.version ?? VERSION;
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 8000;
    this.semaphore = new Semaphore(options.concurrency ?? 4);

    for (const probe of this.probes) {
      this.probesById.set(probe.id, probe);
    }
  }

  async run(): Promise<Run> {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const findings: Finding[] = [];
    const unstable = new Map<string, UnstableAccumulator>();

    for (const probe of this.probes) {
      const prompt = promptOf(probe);
      const perStack = new Map<string, string[]>();

      await Promise.all(
        this.stacks.map(async (stack) => {
          perStack.set(stack.name, await this.trialsFor(stack, prompt, this.trials));
        }),
      );

      for (let i = 0; i < this.stacks.length; i += 1) {
        for (let j = i + 1; j < this.stacks.length; j += 1) {
          const a = this.stacks[i]!;
          const b = this.stacks[j]!;
          const analysis = analyze(
            perStack.get(a.name) ?? [],
            perStack.get(b.name) ?? [],
            this.minStability,
          );
          if (analysis === null) continue;

          if (analysis.verdict === "unstable") {
            const key = `${a.name}\u0000${b.name}`;
            const existing = unstable.get(key);
            if (existing) {
              existing.probes += 1;
              existing.stabilityA = Math.min(
                existing.stabilityA,
                analysis.stabilityA,
              );
              existing.stabilityB = Math.min(
                existing.stabilityB,
                analysis.stabilityB,
              );
            } else {
              unstable.set(key, {
                stackA: a.name,
                stackB: b.name,
                probes: 1,
                exampleProbe: probe.id,
                stabilityA: analysis.stabilityA,
                stabilityB: analysis.stabilityB,
              });
            }
            continue;
          }

          const verdict: DivergenceVerdict | null = analysis.verdict;
          if (verdict === null) continue;

          let finding: Finding = {
            probeId: probe.id,
            tags: [...probe.tags],
            stackA: a.name,
            stackB: b.name,
            verdict,
            severity: severityFor(verdict),
            stabilityA: analysis.stabilityA,
            stabilityB: analysis.stabilityB,
            outputA: analysis.modalA,
            outputB: analysis.modalB,
            originalPrompt: prompt,
            minimizedPrompt: prompt,
            originalSegments: probe.segments.length,
            minimizedSegments: probe.segments.length,
            minimized: false,
            verified: true,
            checks: 0,
            signature: "",
            clusterSize: 1,
          };

          if (this.minimize) {
            finding = await this.minimizeFinding(finding, a, b, probe);
          }

          findings.push(finding);
        }
      }
    }

    assignClusters(findings);

    const unstableGroups: UnstableGroup[] = [...unstable.values()]
      .map((entry) => ({ ...entry }))
      .sort(
        (a, b) =>
          a.stackA.localeCompare(b.stackA) || a.stackB.localeCompare(b.stackB),
      );

    return {
      meta: {
        startedAt,
        durationS: Math.round((performance.now() - started) / 10) / 100,
        seed: this.seed,
        probeCount: this.probes.length,
        trials: this.trials,
        stacks: this.stacks.map((stack) => stack.name),
        version: this.version,
        origin: this.origin,
      },
      findings,
      unstable: unstableGroups,
      stats: { ...this.stats },
      errorSamples: [...this.errorSamples],
    };
  }

  private async trialsFor(
    stack: Runner,
    prompt: string,
    trials: number,
  ): Promise<string[]> {
    const key = JSON.stringify([stack.name, prompt, trials]);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const outputs = await Promise.all(
      Array.from({ length: trials }, (_, trial) =>
        this.trialOutput(stack, prompt, trial),
      ),
    );
    const successful = outputs.filter(
      (output): output is string => output !== null,
    );

    this.cache.set(key, successful);
    return successful;
  }

  private async trialOutput(
    stack: Runner,
    prompt: string,
    trial: number,
  ): Promise<string | null> {
    try {
      return await this.completeWithRetry(stack, prompt, trial);
    } catch (error) {
      if (this.errorSamples.length < 5) {
        const message = error instanceof Error ? error.message : String(error);
        this.errorSamples.push(`${stack.name}: ${message}`);
      }
      return null;
    }
  }

  private async completeWithRetry(
    stack: Runner,
    prompt: string,
    trial: number,
  ): Promise<string> {
    const attempts = this.retries + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const output = await this.semaphore.run(() =>
          stack.complete(prompt, trial),
        );
        this.stats.calls += 1;
        return output;
      } catch (error) {
        lastError = error;
        if (attempt >= attempts - 1 || !isRetryable(error)) break;
        this.stats.retries += 1;
        await sleep(this.retryDelay(attempt, error));
      }
    }

    this.stats.errors += 1;
    throw lastError;
  }

  private retryDelay(attempt: number, error: unknown): number {
    if (error instanceof RunnerError && error.retryAfterMs !== undefined) {
      return Math.min(error.retryAfterMs + Math.random() * 500, 120_000);
    }
    const base = Math.min(
      this.retryDelayMs * 2 ** attempt,
      this.retryMaxDelayMs,
    );
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(base * jitter);
  }

  private async minimizeFinding(
    finding: Finding,
    a: Runner,
    b: Runner,
    probe: Probe,
  ): Promise<Finding> {
    const indices = probe.segments.map((_, index) => index);
    const target = differenceFingerprint(
      finding.verdict,
      finding.outputA,
      finding.outputB,
    );

    const reproduces = (
      analysis: ReturnType<typeof analyze>,
    ): analysis is NonNullable<ReturnType<typeof analyze>> => {
      if (analysis === null || analysis.verdict !== finding.verdict) {
        return false;
      }
      return (
        differenceFingerprint(
          finding.verdict,
          analysis.modalA,
          analysis.modalB,
        ) === target
      );
    };

    const test = async (candidate: number[]): Promise<boolean> => {
      const reduced = probeWithSegments(probe, candidate);
      const [outputsA, outputsB] = await Promise.all([
        this.trialsFor(a, promptOf(reduced), 1),
        this.trialsFor(b, promptOf(reduced), 1),
      ]);
      return reproduces(analyze(outputsA, outputsB, 1));
    };

    const { kept, checks } = await ddmin(indices, test, {
      protected: probe.protected,
      maxChecks: this.maxChecks,
    });
    this.stats.minimizeChecks += checks;

    let finalKept = kept;
    let verified = true;
    let outputA = finding.outputA;
    let outputB = finding.outputB;
    let stabilityA = finding.stabilityA;
    let stabilityB = finding.stabilityB;

    if (kept.length < indices.length) {
      const reduced = probeWithSegments(probe, kept);
      const [outputsA, outputsB] = await Promise.all([
        this.trialsFor(a, promptOf(reduced), this.trials),
        this.trialsFor(b, promptOf(reduced), this.trials),
      ]);
      const check = analyze(outputsA, outputsB, this.minStability);

      if (reproduces(check)) {
        outputA = check.modalA;
        outputB = check.modalB;
        stabilityA = check.stabilityA;
        stabilityB = check.stabilityB;
      } else {
        finalKept = indices;
        verified = false;
      }
    }

    const finalProbe = probeWithSegments(probe, finalKept);
    return {
      ...finding,
      outputA,
      outputB,
      stabilityA,
      stabilityB,
      minimizedPrompt: promptOf(finalProbe),
      minimizedSegments: finalKept.length,
      minimized: finalKept.length < indices.length,
      verified,
      checks,
    };
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RunnerError) return error.retryable;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function assignClusters(findings: Finding[]): void {
  const groups = new Map<string, Finding[]>();

  for (const finding of findings) {
    const key = signature(finding.verdict, finding.outputA, finding.outputB);
    finding.signature = key;
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }

  for (const group of groups.values()) {
    for (const finding of group) {
      finding.clusterSize = group.length;
    }
  }
}
