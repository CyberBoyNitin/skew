import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/core.ts";
import { generateProbes } from "../src/generate.ts";
import { promptOf } from "../src/probe.ts";
import {
  AlphaStack,
  AnthropicRunner,
  BetaStack,
  HttpRunner,
  parseRetryAfter,
  RunnerError,
} from "../src/runners.ts";

test("demo stacks disagree on an unsafe integer", async () => {
  const probe = generateProbes({ count: 2, seed: 7 })[1]!;
  const [a, b] = await Promise.all([
    new AlphaStack().complete(promptOf(probe)),
    new BetaStack().complete(promptOf(probe)),
  ]);

  assert.equal(analyze([a], [b])?.verdict, "semantic");
});

test("demo stacks agree semantically on a unicode string", async () => {
  const probe = generateProbes({ count: 1, seed: 7 })[0]!;
  const [a, b] = await Promise.all([
    new AlphaStack().complete(promptOf(probe)),
    new BetaStack().complete(promptOf(probe)),
  ]);

  assert.equal(analyze([a], [b])?.verdict, "format-only");
});

test("HttpRunner posts a chat-completions request and extracts content", async () => {
  const originalFetch = globalThis.fetch;
  let url = "";
  let init: RequestInit | undefined;

  globalThis.fetch = (async (
    input: string | URL | Request,
    options?: RequestInit,
  ) => {
    url = String(input);
    init = options;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const runner = new HttpRunner({
      name: "mock",
      baseUrl: "http://example.test/v1/",
      model: "mock-1",
      apiKey: "secret",
    });

    const output = await runner.complete("hi", 2);
    assert.equal(output, "hello");
    assert.equal(url, "http://example.test/v1/chat/completions");

    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer secret");

    const body = JSON.parse(String(init?.body)) as {
      model: string;
      seed: number;
      temperature: number;
      max_tokens: number;
    };
    assert.equal(body.model, "mock-1");
    assert.equal(body.seed, 2);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 512);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpRunner explains truncated empty content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "length",
            message: { content: null, reasoning: "..." },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const runner = new HttpRunner({
      name: "mock",
      baseUrl: "http://example.test/v1",
      model: "mock-1",
      maxTokens: 64,
    });

    await assert.rejects(
      () => runner.complete("hi"),
      /finish_reason=length; raise maxTokens above 64/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseRetryAfter reads headers and provider rate-limit bodies", () => {
  assert.equal(parseRetryAfter("2", ""), 2000);

  const reset = parseRetryAfter(
    null,
    JSON.stringify({ error: { reset_seconds: 3 } }),
  );
  assert.ok(reset !== undefined && reset >= 2900 && reset <= 3000);

  const when = new Date(Date.now() + 5000).toISOString();
  const retryAt = parseRetryAfter(
    null,
    JSON.stringify({ error: { retry_after: when } }),
  );
  assert.ok(retryAt !== undefined && retryAt > 3000 && retryAt <= 5000);

  assert.equal(parseRetryAfter(null, "not json"), undefined);
});

test("HttpRunner exposes retry-after on 429", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "slow down" } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "7" },
    })) as typeof fetch;

  try {
    const runner = new HttpRunner({
      name: "mock",
      baseUrl: "http://example.test/v1",
      model: "mock-1",
    });

    await assert.rejects(
      () => runner.complete("hi"),
      (error: unknown) =>
        error instanceof RunnerError &&
        error.retryable &&
        error.retryAfterMs === 7000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const LOOKUP_TOOL = {
  name: "lookup_customer",
  description: "Look up a customer by email.",
  parameters: {
    type: "object",
    properties: { email: { type: "string" } },
    required: ["email"],
  },
};

test("HttpRunner sends tools and normalizes native tool calls", async () => {
  const originalFetch = globalThis.fetch;
  let init: RequestInit | undefined;

  globalThis.fetch = (async (
    _input: string | URL | Request,
    options?: RequestInit,
  ) => {
    init = options;
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "lookup_customer",
                    arguments: '{"email":"ada@example.com"}',
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const runner = new HttpRunner({
      name: "mock",
      baseUrl: "http://example.test/v1",
      model: "mock-1",
      tools: [LOOKUP_TOOL],
      toolChoice: "auto",
    });

    const output = await runner.complete("hi");
    assert.equal(
      output,
      '{"tool_calls":[{"name":"lookup_customer","arguments":{"email":"ada@example.com"}}]}',
    );

    const body = JSON.parse(String(init?.body)) as {
      tools: unknown;
      tool_choice: string;
    };
    assert.deepEqual(body.tools, [
      { type: "function", function: LOOKUP_TOOL },
    ]);
    assert.equal(body.tool_choice, "auto");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicRunner posts Messages requests and normalizes tool use", async () => {
  const originalFetch = globalThis.fetch;
  let url = "";
  let init: RequestInit | undefined;

  globalThis.fetch = (async (
    input: string | URL | Request,
    options?: RequestInit,
  ) => {
    url = String(input);
    init = options;
    return new Response(
      JSON.stringify({
        content: [
          { type: "text", text: "Sure, looking it up." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "lookup_customer",
            input: { email: "ada@example.com" },
          },
        ],
        stop_reason: "tool_use",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const runner = new AnthropicRunner({
      name: "claude",
      baseUrl: "http://example.test/v1/",
      model: "claude-test",
      apiKey: "secret",
      maxTokens: 256,
      tools: [LOOKUP_TOOL],
      toolChoice: "required",
    });

    const output = await runner.complete("hi", 2);
    assert.equal(url, "http://example.test/v1/messages");
    assert.equal(
      output,
      '{"text":"Sure, looking it up.","tool_calls":[{"name":"lookup_customer","arguments":{"email":"ada@example.com"}}]}',
    );

    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), "secret");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");

    const body = JSON.parse(String(init?.body)) as {
      max_tokens: number;
      tools: unknown;
      tool_choice: unknown;
    };
    assert.equal(body.max_tokens, 256);
    assert.deepEqual(body.tools, [
      {
        name: LOOKUP_TOOL.name,
        description: LOOKUP_TOOL.description,
        input_schema: LOOKUP_TOOL.parameters,
      },
    ]);
    assert.deepEqual(body.tool_choice, { type: "any" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicRunner explains max_tokens stops", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        content: [],
        stop_reason: "max_tokens",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const runner = new AnthropicRunner({
      name: "claude",
      baseUrl: "https://api.anthropic.test/v1",
      model: "claude-test",
      maxTokens: 64,
    });

    await assert.rejects(
      () => runner.complete("hi"),
      /stop_reason=max_tokens; raise maxTokens above 64/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicRunner exposes retry-after on 429", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "slow down" },
      }),
      {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "3" },
      },
    )) as typeof fetch;

  try {
    const runner = new AnthropicRunner({
      name: "claude",
      baseUrl: "https://api.anthropic.test/v1",
      model: "claude-test",
    });

    await assert.rejects(
      () => runner.complete("hi"),
      (error: unknown) =>
        error instanceof RunnerError &&
        error.retryable &&
        error.retryAfterMs === 3000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("toolChoice none omits tool definitions", async () => {
  const originalFetch = globalThis.fetch;
  let init: RequestInit | undefined;
  globalThis.fetch = (async (
    _input: string | URL | Request,
    options?: RequestInit,
  ) => {
    init = options;
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const runner = new HttpRunner({
      name: "mock",
      baseUrl: "http://example.test/v1",
      model: "mock-1",
      tools: [LOOKUP_TOOL],
      toolChoice: "none",
    });
    await runner.complete("hi");

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
