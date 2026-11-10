import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../src/core.ts";
import { generateProbes } from "../src/generate.ts";
import { Harness } from "../src/harness.ts";
import { writeArtifacts } from "../src/report.ts";
import { demoStacks } from "../src/runners.ts";

test("demo pipeline produces every verdict class and artifacts", async () => {
  const probes = generateProbes({ count: 8, seed: 7 });
  const harness = new Harness({
    probes,
    stacks: demoStacks(),
    trials: 3,
    minimize: true,
    maxChecks: 8,
    seed: 7,
    origin: "demo",
  });

  const run = await harness.run();
  const verdicts = new Set(run.findings.map((finding) => finding.verdict));

  assert.ok(verdicts.has("format-only"), "expected format-only findings");
  assert.ok(verdicts.has("semantic"), "expected semantic findings");
  assert.ok(verdicts.has("safety"), "expected safety findings");
  assert.equal(run.unstable.length, 3);
  assert.ok(run.findings.length >= 10);
  assert.ok(run.findings.some((finding) => finding.minimized));
  assert.ok(run.findings.every((finding) => finding.verified));

  const stacks = new Map(demoStacks().map((stack) => [stack.name, stack]));
  for (const finding of run.findings.filter((item) => item.minimized)) {
    const a = stacks.get(finding.stackA);
    const b = stacks.get(finding.stackB);
    assert.ok(a && b);

    const [outputA, outputB] = await Promise.all([
      a.complete(finding.minimizedPrompt),
      b.complete(finding.minimizedPrompt),
    ]);
    assert.equal(canonical(outputA), canonical(finding.outputA));
    assert.equal(canonical(outputB), canonical(finding.outputB));
  }

  const dir = await mkdtemp(join(tmpdir(), "skew-test-"));
  await writeArtifacts(run, dir);

  const html = await readFile(join(dir, "report.html"), "utf8");
  const jsonl = await readFile(join(dir, "findings.jsonl"), "utf8");
  const summary = JSON.parse(
    await readFile(join(dir, "summary.json"), "utf8"),
  ) as { counts: { total: number } };

  assert.ok(html.includes("SKEW"));
  assert.ok(html.includes("minimized repro"));
  assert.equal(jsonl.trim().split("\n").length, run.findings.length);
  assert.equal(summary.counts.total, run.findings.length);
});
