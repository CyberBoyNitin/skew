import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

test("CLI demo writes a report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skew-cli-"));
  const { stdout } = await exec(
    process.execPath,
    [
      "src/cli.ts",
      "demo",
      "--out",
      dir,
      "--probes",
      "2",
      "--trials",
      "3",
      "--max-checks",
      "2",
    ],
    { cwd: root },
  );

  assert.match(stdout, /divergences/);
  assert.match(stdout, /report\.html/);
});

test("CLI records a run and replays it without network access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skew-replay-cli-"));
  const recordings = join(dir, "recordings");
  const recordedOut = join(dir, "recorded");
  const replayedOut = join(dir, "replayed");

  const recorded = await exec(
    process.execPath,
    [
      "src/cli.ts",
      "demo",
      "--out",
      recordedOut,
      "--probes",
      "2",
      "--trials",
      "3",
      "--max-checks",
      "2",
      "--record",
      recordings,
    ],
    { cwd: root },
  );
  assert.match(recorded.stdout, /recorded\s+\d+ completions/);

  const configPath = join(dir, "skew.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      seed: 7,
      probes: 2,
      trials: 3,
      maxChecks: 2,
      stacks: ["alpha", "beta", "gamma", "delta"].map((name) => ({
        name,
        baseUrl: "http://localhost:9/v1",
        model: name,
      })),
    }),
    "utf8",
  );

  const replayed = await exec(
    process.execPath,
    [
      "src/cli.ts",
      "run",
      "--config",
      configPath,
      "--replay",
      recordings,
      "--out",
      replayedOut,
    ],
    { cwd: root },
  );

  assert.match(replayed.stdout, /replay \(recorded fixtures, no network\)/);
  assert.match(replayed.stdout, /divergences/);
  const html = await readFile(join(replayedOut, "report.html"), "utf8");
  assert.match(html, /replay · recorded fixtures/);
  assert.match(html, /SKEW/);
});
