import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunners, loadConfig, normalizeConfig } from "../src/config.ts";
import { AnthropicRunner, HttpRunner } from "../src/runners.ts";

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

test("defaults are applied", () => {
  const config = normalizeConfig({ stacks: STACKS });

  assert.equal(config.concurrency, 4);
  assert.equal(config.retries, 2);
  assert.equal(config.retryDelayMs, 500);
  assert.equal(config.retryMaxDelayMs, 8000);
  assert.deepEqual(config.probeFiles, []);
  assert.deepEqual(config.customProbes, []);
  assert.deepEqual(config.tools, []);
  assert.equal(config.stacks[0]!.protocol, "openai");
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

test("tools and toolChoice are parsed", () => {
  const tool = {
    name: "lookup_customer",
    description: "Look up a customer by email.",
    parameters: { type: "object", properties: { email: { type: "string" } } },
  };
  const config = normalizeConfig({
    stacks: STACKS,
    tools: [tool],
    toolChoice: "required",
  });

  assert.deepEqual(config.tools, [tool]);
  assert.equal(config.toolChoice, "required");
  assert.equal(config.stacks[0]!.protocol, "openai");
});

test("tool parameters default to an empty object schema", () => {
  const config = normalizeConfig({
    stacks: STACKS,
    tools: [{ name: "ping", description: "Ping the service." }],
  });

  assert.deepEqual(config.tools[0]!.parameters, {
    type: "object",
    properties: {},
  });
});

test("protocol selects the runner implementation", () => {
  const config = normalizeConfig({
    stacks: [
      { ...STACKS[0]!, protocol: "anthropic" },
      STACKS[1]!,
    ],
  });

  const runners = buildRunners(config);
  assert.ok(runners[0] instanceof AnthropicRunner);
  assert.ok(runners[1] instanceof HttpRunner);
});

test("invalid tool definitions and protocols are rejected", () => {
  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        tools: [
          { name: "a", description: "one" },
          { name: "a", description: "two" },
        ],
      }),
    /duplicate tool name/,
  );

  assert.throws(
    () => normalizeConfig({ stacks: STACKS, tools: [{ name: "a" }] }),
    /description/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: [{ ...STACKS[0]!, protocol: "grpc" }, STACKS[1]!],
      }),
    /protocol/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: [
          { ...STACKS[0]!, protocol: "anthropic", temperature: 1.5 },
          STACKS[1]!,
        ],
      }),
    /temperature/,
  );

  assert.throws(
    () => normalizeConfig({ stacks: STACKS, toolChoice: "auto" }),
    /requires at least one/,
  );
});
