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

test("agent loop config parses maxTurns and static tool results", () => {
  const tool = {
    name: "lookup_customer",
    description: "Look up a customer by email.",
    parameters: { type: "object", properties: { email: { type: "string" } } },
  };
  const config = normalizeConfig({
    stacks: STACKS,
    maxTurns: 4,
    tools: [tool],
    toolResults: {
      lookup_customer: { id: "cus_1042", status: "active" },
    },
  });

  assert.equal(config.maxTurns, 4);
  assert.equal(config.agentText, "final");
  assert.deepEqual(config.toolResults, {
    lookup_customer: { id: "cus_1042", status: "active" },
  });
});

test("agentText accepts all, final, and none and rejects unknown modes", () => {
  const all = normalizeConfig({
    stacks: STACKS,
    agentText: "all",
  });
  assert.equal(all.agentText, "all");

  const none = normalizeConfig({
    stacks: STACKS,
    agentText: "none",
  });
  assert.equal(none.agentText, "none");

  assert.throws(
    () => normalizeConfig({ stacks: STACKS, agentText: "every" }),
    /agentText must be/,
  );
});

test("agent loop config requires a result for every tool", () => {
  const tool = {
    name: "lookup_customer",
    description: "Look up a customer by email.",
  };

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
      }),
    /requires config\.toolResults/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolResults: {},
      }),
    /missing a result/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolResults: {
          lookup_customer: {},
          other_tool: {},
        },
      }),
    /unknown tool/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 1,
        tools: [tool],
        toolResults: {
          lookup_customer: {},
        },
      }),
    /requires maxTurns >= 2/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolChoice: "none",
        toolResults: {
          lookup_customer: {},
        },
      }),
    /toolChoice "none"/,
  );
});

test("agent loop config parses sequenced tool results", () => {
  const tool = {
    name: "get_order",
    description: "Fetch an order.",
  };
  const config = normalizeConfig({
    stacks: STACKS,
    maxTurns: 3,
    tools: [tool],
    toolSequences: {
      get_order: [
        { error: { code: "timeout", message: "upstream timeout" } },
        { result: { order_id: "8812", status: "delivered" } },
      ],
    },
  });

  assert.deepEqual(config.toolResults, {});
  assert.deepEqual(config.toolSequences, {
    get_order: [
      { error: { code: "timeout", message: "upstream timeout" } },
      { result: { order_id: "8812", status: "delivered" } },
    ],
  });
});

test("agent loop config validates sequenced tool results", () => {
  const tool = {
    name: "get_order",
    description: "Fetch an order.",
  };

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolSequences: { get_order: [] },
      }),
    /non-empty array/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolSequences: { get_order: [{ result: {}, error: {} }] },
      }),
    /exactly one of "result" or "error"/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolSequences: { get_order: [{}] },
      }),
    /exactly one of "result" or "error"/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolSequences: { other_tool: [{ result: {} }] },
      }),
    /unknown tool/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 1,
        tools: [tool],
        toolSequences: { get_order: [{ result: {} }] },
      }),
    /requires maxTurns >= 2/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolResults: { get_order: {} },
        toolSequences: { get_order: [{ result: {} }] },
      }),
    /cannot be combined/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolChoice: "none",
        toolSequences: { get_order: [{ result: {} }] },
      }),
    /toolChoice "none"/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool, { name: "get_customer", description: "Fetch." }],
        toolSequences: { get_order: [{ result: {} }] },
      }),
    /missing a result or route for tool "get_customer"/,
  );
});

test("agent loop config parses argument-aware tool routes", () => {
  const tool = {
    name: "get_order",
    description: "Fetch an order.",
  };
  const config = normalizeConfig({
    stacks: STACKS,
    maxTurns: 3,
    tools: [tool],
    toolRoutes: {
      get_order: [
        {
          when: { order_id: "8812" },
          result: { order_id: "8812", status: "delivered" },
        },
        {
          when: { order_id: "5521" },
          sequence: [
            { error: { code: "timeout", retryable: true } },
            { result: { order_id: "5521", status: "processing" } },
          ],
        },
        { error: { code: "not_found", retryable: false } },
      ],
    },
  });

  assert.deepEqual(config.toolResults, {});
  assert.deepEqual(config.toolSequences, {});
  assert.deepEqual(config.toolRoutes, {
    get_order: [
      {
        when: { order_id: "8812" },
        result: { order_id: "8812", status: "delivered" },
      },
      {
        when: { order_id: "5521" },
        sequence: [
          { error: { code: "timeout", retryable: true } },
          { result: { order_id: "5521", status: "processing" } },
        ],
      },
      { error: { code: "not_found", retryable: false } },
    ],
  });
});

test("agent loop config validates argument-aware tool routes", () => {
  const tool = {
    name: "get_order",
    description: "Fetch an order.",
  };

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolRoutes: { get_order: [] },
      }),
    /non-empty array/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolRoutes: {
          get_order: [{ when: {}, result: { ok: true } }],
        },
      }),
    /when must not be empty/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolRoutes: {
          get_order: [
            { result: {} },
            { when: { order_id: "8812" }, result: {} },
          ],
        },
      }),
    /fallback route must be last/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolRoutes: {
          get_order: [
            { result: {} },
            { when: { order_id: "8812" }, result: {} },
          ],
        },
      }),
    /fallback route must be last/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolRoutes: {
          get_order: [{ result: {} }, { result: {} }],
        },
      }),
    /at most one fallback route/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolRoutes: {
          get_order: [{ result: {} }],
          other_tool: [{ result: {} }],
        },
      }),
    /unknown tool/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 1,
        tools: [tool],
        toolRoutes: { get_order: [{ result: {} }] },
      }),
    /requires maxTurns >= 2/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolResults: { get_order: {} },
        toolRoutes: { get_order: [{ result: {} }] },
      }),
    /cannot be combined/,
  );

  assert.throws(
    () =>
      normalizeConfig({
        stacks: STACKS,
        maxTurns: 2,
        tools: [tool],
        toolSequences: { get_order: [{ result: {} }] },
        toolRoutes: { get_order: [{ result: {} }] },
      }),
    /cannot be combined/,
  );
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
