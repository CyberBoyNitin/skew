import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/core.ts";
import { generateProbes } from "../src/generate.ts";
import { promptOf } from "../src/probe.ts";
import { AlphaStack, BetaStack, HttpRunner } from "../src/runners.ts";

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
    };
    assert.equal(body.model, "mock-1");
    assert.equal(body.seed, 2);
    assert.equal(body.temperature, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
