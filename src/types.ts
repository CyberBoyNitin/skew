export type Verdict = "format-only" | "semantic" | "safety" | "unstable";

export type DivergenceVerdict = Exclude<Verdict, "unstable">;

export interface PairAnalysis {
  verdict: Verdict | null;
  stabilityA: number;
  stabilityB: number;
  modalA: string;
  modalB: string;
}

export interface Runner {
  readonly name: string;
  complete(prompt: string, trial?: number): Promise<string>;
}

export interface RunStats {
  calls: number;
  errors: number;
  retries: number;
  minimizeChecks: number;
}

export interface Finding {
  probeId: string;
  tags: string[];
  stackA: string;
  stackB: string;
  verdict: DivergenceVerdict;
  severity: number;
  stabilityA: number;
  stabilityB: number;
  outputA: string;
  outputB: string;
  originalPrompt: string;
  minimizedPrompt: string;
  originalSegments: number;
  minimizedSegments: number;
  minimized: boolean;
  verified: boolean;
  checks: number;
  signature: string;
  clusterSize: number;
}

export interface UnstableGroup {
  stackA: string;
  stackB: string;
  probes: number;
  exampleProbe: string;
  stabilityA: number;
  stabilityB: number;
}

export interface RunMeta {
  startedAt: string;
  durationS: number;
  seed: number;
  probeCount: number;
  trials: number;
  stacks: string[];
  version: string;
  origin: string;
}

export interface Run {
  meta: RunMeta;
  findings: Finding[];
  unstable: UnstableGroup[];
  stats: RunStats;
  errorSamples: string[];
}

export interface HttpRunnerOptions {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  timeoutMs?: number;
}
