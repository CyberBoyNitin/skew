import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/core.ts";
import { generateProbes } from "../src/generate.ts";
import { promptOf } from "../src/probe.ts";
import {
  AlphaStack,
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
