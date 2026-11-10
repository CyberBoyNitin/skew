#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildRunners, loadConfig } from "./config.ts";
import { generateProbes } from "./generate.ts";
import { Harness } from "./harness.ts";
import { printSummary, writeArtifacts } from "./report.ts";
import { demoStacks } from "./runners.ts";
import type { DivergenceVerdict, Run, Runner } from "./types.ts";
import { VERSION } from "./version.ts";
import type { Probe } from "./probe.ts";

const USAGE = `skew v${VERSION} · differential fuzzing for LLM stacks

usage
  skew demo [options]                 run the offline scripted demo
  skew run --config <file> [options]  compare live OpenAI-compatible stacks

options
  -o, --out <dir>        artifact directory (default: runs/<timestamp>)
      --seed <n>         generator seed (default: 7)
      --probes <n>       number of generated probes (default: 8 demo / 12 run)
      --trials <n>       samples per stack per probe (default: 3)
      --max-checks <n>   minimization budget per finding (default: 30)
      --no-minimize      skip delta debugging
      --fail-on <class>  exit 1 on format-only | semantic | safety
  -h, --help             show this help
  -v, --version          print the version

examples
  npm run demo
  node src/cli.ts run --config examples/skew.config.json
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
    const seed = numericOption(values.seed, 7, "--seed");
    const probes = generateProbes({
      count: numericOption(values.probes, 8, "--probes"),
      seed,
    });
    const outDir = resolve(values.out ?? defaultOutDir());

    process.exitCode = await execute({
      probes,
      stacks: demoStacks(),
      trials: numericOption(values.trials, 3, "--trials"),
      seed,
      maxChecks: numericOption(values["max-checks"], 30, "--max-checks"),
      minStability: 0.8,
      minimize: values["no-minimize"] !== true,
      origin: "demo",
      outDir,
      failOn: parseFailOn(values["fail-on"]),
    });
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

    const config = await loadConfig(values.config);
    const seed = numericOption(values.seed, config.seed, "--seed");
    const probes = generateProbes({
      count: numericOption(values.probes, config.probes, "--probes"),
      seed,
    });
    const outDir = resolve(values.out ?? defaultOutDir());

    process.exitCode = await execute({
      probes,
      stacks: buildRunners(config),
      trials: numericOption(values.trials, config.trials, "--trials"),
      seed,
      maxChecks: numericOption(
        values["max-checks"],
        config.maxChecks,
        "--max-checks",
      ),
      minStability: config.minStability,
      minimize: values["no-minimize"] === true ? false : config.minimize,
      origin: "live",
      outDir,
      failOn: parseFailOn(values["fail-on"]),
    });
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
  });

  const run = await harness.run();
  const outDir = await writeArtifacts(run, options.outDir);
  printSummary(run, outDir);

  return shouldFail(run, options.failOn) ? 1 : 0;
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
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer (got "${value}")`);
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
