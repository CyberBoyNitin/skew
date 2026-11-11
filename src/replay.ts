import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunnerError } from "./runners.ts";
import type { Runner } from "./types.ts";

export interface ReplayEntry {
  prompt: string;
  trial: number;
  output: string;
}

export interface ReplayManifest {
  version: number;
  createdAt: string;
  skew: string;
  stacks: string[];
}

function key(prompt: string, trial: number): string {
  return JSON.stringify([prompt, trial]);
}

export function safeStackName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Wraps a live runner and remembers every successful completion. Call
 * saveRecordings() after the run to write a replayable fixture directory.
 */
export class RecordingRunner implements Runner {
  readonly name: string;
  private readonly inner: Runner;
  private readonly entries = new Map<string, ReplayEntry>();

  constructor(inner: Runner) {
    this.inner = inner;
    this.name = inner.name;
  }

  async complete(prompt: string, trial = 0): Promise<string> {
    const output = await this.inner.complete(prompt, trial);
    this.entries.set(key(prompt, trial), { prompt, trial, output });
    return output;
  }

  get size(): number {
    return this.entries.size;
  }

  entriesInOrder(): ReplayEntry[] {
    return [...this.entries.values()];
  }
}

export async function saveRecordings(
  dir: string,
  runners: RecordingRunner[],
  version: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });

  const used = new Set<string>();
  for (const runner of runners) {
    const file = safeStackName(runner.name);
    if (used.has(file)) {
      throw new Error(`duplicate recording file name for stack "${runner.name}"`);
    }
    used.add(file);

    const lines = runner.entriesInOrder().map((entry) => JSON.stringify(entry));
    await writeFile(
      join(dir, `${file}.jsonl`),
      lines.length > 0 ? `${lines.join("\n")}\n` : "",
      "utf8",
    );
  }

  const manifest: ReplayManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    skew: version,
    stacks: runners.map((runner) => runner.name),
  };
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

export class ReplayRunner implements Runner {
  readonly name: string;
  private readonly outputs: Map<string, string>;

  constructor(name: string, outputs: Map<string, string>) {
    this.name = name;
    this.outputs = outputs;
  }

  async complete(prompt: string, trial = 0): Promise<string> {
    const output = this.outputs.get(key(prompt, trial));
    if (output === undefined) {
      throw new RunnerError(
        `${this.name}: no recorded output for trial ${trial} (${prompt.length} char prompt)`,
        { retryable: false },
      );
    }
    return output;
  }
}

export async function loadReplayRunners(
  dir: string,
  names: string[],
): Promise<ReplayRunner[]> {
  const used = new Set<string>();

  return Promise.all(
    names.map(async (name) => {
      const file = safeStackName(name);
      if (used.has(file)) {
        throw new Error(`duplicate replay file name for stack "${name}"`);
      }
      used.add(file);

      const path = join(dir, `${file}.jsonl`);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        throw new Error(`replay file not found for stack "${name}": ${path}`);
      }

      const outputs = new Map<string, string>();
      raw.split(/\r?\n/).forEach((line, index) => {
        if (line.trim() === "") return;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch (error) {
          throw new Error(
            `${path}:${index + 1}: invalid JSON: ${(error as Error).message}`,
          );
        }
        if (
          typeof entry !== "object" ||
          entry === null ||
          typeof (entry as ReplayEntry).prompt !== "string" ||
          !Number.isInteger((entry as ReplayEntry).trial) ||
          typeof (entry as ReplayEntry).output !== "string"
        ) {
          throw new Error(`${path}:${index + 1}: invalid replay entry`);
        }
        const valid = entry as ReplayEntry;
        outputs.set(key(valid.prompt, valid.trial), valid.output);
      });

      return new ReplayRunner(name, outputs);
    }),
  );
}
