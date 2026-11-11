import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateProbes } from "../src/generate.ts";
import { Harness } from "../src/harness.ts";
import {
  loadReplayRunners,
  RecordingRunner,
  ReplayRunner,
  saveRecordings,
} from "../src/replay.ts";
import { demoStacks } from "../src/runners.ts";
import type { Run, Runner } from "../src/types.ts";

function runWith(stacks: Runner[]): Promise<Run> {
  return new Harness({
    probes: generateProbes({ count: 3, seed: 7 }),
    stacks,
    trials: 3,
    minimize: true,
    maxChecks: 6,
    concurrency: 4,
    retries: 0,
    origin: "test",
  }).run();
}

function summarize(run: Run): unknown {
  return run.findings.map((finding) => ({
    probeId: finding.probeId,
    stackA: finding.stackA,
    stackB: finding.stackB,
    verdict: finding.verdict,
    prompt: finding.minimizedPrompt,
    outputA: finding.outputA,
    outputB: finding.outputB,
  }));
}

test("a recorded run replays identically", async () => {
  const recorders = demoStacks().map((stack) => new RecordingRunner(stack));
  const first = await runWith(recorders);

  const dir = await mkdtemp(join(tmpdir(), "skew-replay-"));
  await saveRecordings(dir, recorders, "0.2.0");

  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  ) as { stacks: string[] };
  assert.deepEqual(manifest.stacks, ["alpha", "beta", "gamma", "delta"]);

  const replayers = await loadReplayRunners(
    dir,
    recorders.map((runner) => runner.name),
  );
  const second = await runWith(replayers);

  assert.deepEqual(summarize(second), summarize(first));
  assert.equal(second.stats.calls, first.stats.calls);
  assert.equal(second.stats.minimizeChecks, first.stats.minimizeChecks);
  assert.equal(second.stats.retries, 0);
});

test("a replay miss fails loudly without retrying", async () => {
  const runner = new ReplayRunner("ghost", new Map());

  await assert.rejects(
    () => runner.complete("not recorded", 0),
    /no recorded output/,
  );
});
