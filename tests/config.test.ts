import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, normalizeConfig } from "../src/config.ts";

const STACKS = [
  {
    name: "a",
    baseUrl: "http://localhost:8001/v1",
    model: "a",
  },
  {
    name: "b",
    baseUrl: "http://localhost:8002/v1",
    model: "b",
  },
];

test("v0.2 defaults are applied", () => {
  const config = normalizeConfig({ stacks: STACKS });

  assert.equal(config.concurrency, 4);
  assert.equal(config.retries, 2);
  assert.equal(config.retryDelayMs, 500);
  assert.equal(config.retryMaxDelayMs, 8000);
  assert.deepEqual(config.probeFiles, []);
  assert.deepEqual(config.customProbes, []);
});

test("probe file paths resolve relative to the config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skew-config-"));
  const path = join(dir, "skew.config.json");
  await writeFile(
    path,
    JSON.stringify({
      stacks: STACKS,
      probeFiles: ["probes/extra.jsonl"],
    }),
    "utf8",
  );

  const config = await loadConfig(path);
  assert.equal(config.probeFiles[0], join(dir, "probes", "extra.jsonl"));
});

test("custom probes are validated during config load", () => {
  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        customProbes: [{ id: "x" }],
      }),
    /exactly one/,
  );
});

test("probe generation can be disabled for custom-only suites", () => {
  const config = normalizeConfig({ stacks: STACKS, probes: 0 });
  assert.equal(config.probes, 0);
});

test("maxTokens is parsed and validated", () => {
  const config = normalizeConfig({
    stacks: [{ ...STACKS[0]!, maxTokens: 64 }, STACKS[1]!],
  });
  assert.equal(config.stacks[0]!.maxTokens, 64);

  assert.throws(
    () =>
      normalizeConfig({
        stacks: [{ ...STACKS[0]!, maxTokens: 0 }, STACKS[1]!],
      }),
    /maxTokens/,
  );
});
