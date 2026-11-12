import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.ts";
import { probeFromSpec } from "../src/probes.ts";
import { RunnerError } from "../src/runners.ts";
import type { Runner } from "../src/types.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class StableRunner implements Runner {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async complete(): Promise<string> {
    return '{"ok":true}';
  }
}

class FlakyRunner implements Runner {
  readonly name = "flaky";
  attempts = 0;

  async complete(): Promise<string> {
    this.attempts += 1;
    if (this.attempts < 3) throw new Error("transient failure");
    return '{"ok":true}';
  }
}

class BlockedRunner implements Runner {
  readonly name = "blocked";
  attempts = 0;

  async complete(): Promise<string> {
    this.attempts += 1;
    throw new RunnerError("blocked by policy", { retryable: false });
  }
}

class RateLimitedRunner implements Runner {
  readonly name = "limited";
  attempts = 0;

  async complete(): Promise<string> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new RunnerError("429", { retryAfterMs: 60 });
    }
    return '{"ok":true}';
  }
}

class TrackingRunner implements Runner {
  readonly name: string;
  private readonly delayMs: number;
  active = 0;
  peak = 0;

  constructor(name: string, delayMs: number) {
    this.name = name;
    this.delayMs = delayMs;
  }

  async complete(): Promise<string> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    await sleep(this.delayMs);
    this.active -= 1;
    return "same";
  }
}

test("retryable failures are retried with backoff", async () => {
  const flaky = new FlakyRunner();
  const stable = new StableRunner("stable");

  const run = await new Harness({
    probes: [probeFromSpec({ id: "p", prompt: "hello" })],
    stacks: [flaky, stable],
    trials: 1,
    minimize: false,
    concurrency: 1,
    retries: 2,
    retryDelayMs: 1,
  }).run();

  assert.equal(flaky.attempts, 3);
  assert.equal(run.stats.retries, 2);
  assert.equal(run.stats.errors, 0);
  assert.equal(run.stats.calls, 2);
  assert.equal(run.findings.length, 0);
});

test("retry-after delays override exponential backoff", async () => {
  const limited = new RateLimitedRunner();
  const stable = new StableRunner("stable");
  const started = performance.now();

  const run = await new Harness({
    probes: [probeFromSpec({ id: "p", prompt: "hello" })],
    stacks: [limited, stable],
    trials: 1,
    minimize: false,
    concurrency: 1,
    retries: 1,
    retryDelayMs: 1,
  }).run();

  const elapsed = performance.now() - started;
  assert.equal(limited.attempts, 2);
  assert.equal(run.stats.retries, 1);
  assert.equal(run.stats.errors, 0);
  assert.ok(elapsed >= 45, `expected a retry-after delay, got ${elapsed}ms`);
});

test("non-retryable failures stop immediately", async () => {
  const blocked = new BlockedRunner();
  const stable = new StableRunner("stable");

  const run = await new Harness({
    probes: [probeFromSpec({ id: "p", prompt: "hello" })],
    stacks: [blocked, stable],
    trials: 1,
    minimize: false,
    concurrency: 1,
    retries: 3,
    retryDelayMs: 1,
  }).run();

  assert.equal(blocked.attempts, 1);
  assert.equal(run.stats.retries, 0);
  assert.equal(run.stats.errors, 1);
  assert.equal(run.findings.length, 0);
});

test("the concurrency limit bounds in-flight calls", async () => {
  const a = new TrackingRunner("a", 5);
  const b = new TrackingRunner("b", 5);

  await new Harness({
    probes: [probeFromSpec({ id: "p", prompt: "hello" })],
    stacks: [a, b],
    trials: 4,
    minimize: false,
    concurrency: 2,
    retries: 0,
  }).run();

  assert.equal(Math.max(a.peak, b.peak), 2);
});
