#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildRunners, loadConfig } from "./config.ts";
import { generateProbes } from "./generate.ts";
import { Harness } from "./harness.ts";
import type { Probe } from "./probe.ts";
import { loadProbes } from "./probes.ts";
import {
  loadReplayRunners,
  RecordingRunner,
  saveRecordings,
} from "./replay.ts";
import { printSummary, writeArtifacts } from "./report.ts";
import { demoStacks } from "./runners.ts";
import type { DivergenceVerdict, Run, Runner } from "./types.ts";
import { VERSION } from "./version.ts";

const USAGE = `skew v${VERSION} · differential fuzzing for LLM stacks

usage
  skew demo [options]                 run the offline scripted demo
  skew run --config <file> [options]  compare live OpenAI or Anthropic stacks

options
  -o, --out <dir>        artifact directory (default: runs/<timestamp>)
      --seed <n>         generator seed (default: 7)
      --probes <n>       number of generated probes (default: 8 demo / 12 run)
      --trials <n>       samples per stack per probe (default: 3)
      --max-checks <n>   minimization budget per finding (default: 30)
      --concurrency <n>  max in-flight model calls (default: 4)
      --retries <n>      retries per failed call, with backoff (default: 2)
      --record <dir>     record completions for deterministic replay
      --replay <dir>     replay a recorded run instead of calling stacks
      --no-minimize      skip delta debugging
      --fail-on <class>  exit 1 on format-only | semantic | safety
  -h, --help             show this help
  -v, --version          print the version

examples
  npm run demo
  node src/cli.ts demo --record fixtures/demo
  node src/cli.ts run --config examples/skew.config.json
  node src/cli.ts run --config examples/tools.config.json
  node src/cli.ts run --config skew.config.json --replay fixtures/run-001
  skew demo --out docs/demo --fail-on semantic
`;

type FailOn = "none" | DivergenceVerdict;

const FAIL_THRESHOLD: Record<FailOn, number> = {
  none: Number.POSITIVE_INFINITY,
  "format-only": 1,
  semantic: 2,
  safety: 3,
};

interface ExecuteOptions {
  probes: Probe[];
  stacks: Runner[];
  trials: number;
  seed: number;
  maxChecks: number;
  minStability: number;
  minimize: boolean;
  concurrency: number;
  retries: number;
  retryDelayMs: number;
  retryMaxDelayMs: number;
  origin: string;
  outDir: string;
  failOn: FailOn;
}

async function main(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string", short: "c" },
        out: { type: "string", short: "o" },
        seed: { type: "string" },
        probes: { type: "string" },
        trials: { type: "string" },
        "max-checks": { type: "string" },
        concurrency: { type: "string" },
        retries: { type: "string" },
        record: { type: "string" },
        replay: { type: "string" },
        "no-minimize": { type: "boolean" },
        "fail-on": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    console.error((error as Error).message);
    console.error("");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const { values, positionals } = parsed;
  const command = positionals[0] ?? "demo";

  if (values.help || command === "help") {
    console.log(USAGE);
    return;
  }
  if (values.version || command === "version") {
    console.log(VERSION);
    return;
  }

  if (command === "demo") {
    if (values.replay) {
      throw new Error("--replay is only available for run, not demo");
    }

    const seed = numericOption(values.seed, 7, "--seed");
    const probes = generateProbes({
      count: numericOption(values.probes, 8, "--probes"),
      seed,
    });
    const outDir = resolve(values.out ?? defaultOutDir());
    const recorders = values.record
      ? demoStacks().map((stack) => new RecordingRunner(stack))
      : [];

    process.exitCode = await execute({
      probes,
      stacks: recorders.length > 0 ? recorders : demoStacks(),
      trials: numericOption(values.trials, 3, "--trials"),
      seed,
      maxChecks: numericOption(values["max-checks"], 30, "--max-checks"),
      minStability: 0.8,
      minimize: values["no-minimize"] !== true,
      concurrency: numericOption(values.concurrency, 4, "--concurrency"),
      retries: integerOption(values.retries, 2, "--retries", 0),
      retryDelayMs: 500,
      retryMaxDelayMs: 8000,
      origin: "demo",
      outDir,
      failOn: parseFailOn(values["fail-on"]),
    });

    if (values.record) {
      await persistRecordings(values.record, recorders);
    }
    return;
  }

  if (command === "run") {
    if (!values.config) {
      console.error("run requires --config <file>");
      console.error("");
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    if (values.record && values.replay) {
      throw new Error("--record and --replay cannot be combined");
    }

    const config = await loadConfig(values.config);
    const seed = numericOption(values.seed, config.seed, "--seed");
    const probes = await loadProbes({
      generated: numericOption(values.probes, config.probes, "--probes"),
      seed,
      custom: config.customProbes,
      files: config.probeFiles,
    });
    const outDir = resolve(values.out ?? defaultOutDir());

    const liveStacks = values.replay
      ? await loadReplayRunners(
          resolve(values.replay),
          config.stacks.map((stack) => stack.name),
        )
      : buildRunners(config);
    const recorders =
      !values.replay && values.record
        ? liveStacks.map((stack) => new RecordingRunner(stack))
        : [];

    process.exitCode = await execute({
      probes,
      stacks: recorders.length > 0 ? recorders : liveStacks,
      trials: numericOption(values.trials, config.trials, "--trials"),
      seed,
      maxChecks: numericOption(
        values["max-checks"],
        config.maxChecks,
        "--max-checks",
      ),
      minStability: config.minStability,
      minimize: values["no-minimize"] === true ? false : config.minimize,
      concurrency: numericOption(
        values.concurrency,
        config.concurrency,
        "--concurrency",
      ),
      retries: integerOption(values.retries, config.retries, "--retries", 0),
      retryDelayMs: config.retryDelayMs,
      retryMaxDelayMs: config.retryMaxDelayMs,
      origin: values.replay ? "replay" : "live",
      outDir,
      failOn: parseFailOn(values["fail-on"]),
    });

    if (values.record) {
      await persistRecordings(values.record, recorders);
    }
    return;
  }

  console.error(`unknown command: ${command}`);
  console.error("");
  console.error(USAGE);
  process.exitCode = 2;
}

async function execute(options: ExecuteOptions): Promise<number> {
  const harness = new Harness({
    probes: options.probes,
    stacks: options.stacks,
    trials: options.trials,
    minStability: options.minStability,
    minimize: options.minimize,
    maxChecks: options.maxChecks,
    seed: options.seed,
    origin: options.origin,
    concurrency: options.concurrency,
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
    retryMaxDelayMs: options.retryMaxDelayMs,
  });

  const run = await harness.run();
  const outDir = await writeArtifacts(run, options.outDir);
  printSummary(run, outDir);

  return shouldFail(run, options.failOn) ? 1 : 0;
}

async function persistRecordings(
  target: string,
  recorders: RecordingRunner[],
): Promise<void> {
  if (recorders.length === 0) return;
  const dir = resolve(target);
  await saveRecordings(dir, recorders, VERSION);
  const total = recorders.reduce((sum, runner) => sum + runner.size, 0);
  console.log(`recorded  ${total} completions -> ${dir}`);
  console.log("");
}

function shouldFail(run: Run, failOn: FailOn): boolean {
  if (failOn === "none") return false;
  const threshold = FAIL_THRESHOLD[failOn];
  return run.findings.some((finding) => finding.severity >= threshold);
}

function parseFailOn(value: string | undefined): FailOn {
  if (value === undefined) return "none";
  if (
    value === "none" ||
    value === "format-only" ||
    value === "semantic" ||
    value === "safety"
  ) {
    return value;
  }
  throw new Error(
    `--fail-on must be one of: none, format-only, semantic, safety (got "${value}")`,
  );
}

function numericOption(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  return integerOption(value, fallback, label, 1);
}

function integerOption(
  value: string | undefined,
  fallback: number,
  label: string,
  min: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${label} must be an integer >= ${min} (got "${value}")`);
  }
  return parsed;
}

function defaultOutDir(): string {
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replaceAll(":", "-");
  return `runs/${stamp}`;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
