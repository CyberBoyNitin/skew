import test from "node:test";
import assert from "node:assert/strict";
import { ddmin } from "../src/minimize.ts";

test("ddmin removes filler and keeps the required segment", async () => {
  const { kept, checks } = await ddmin(
    [0, 1, 2, 3, 4, 5],
    async (candidate) => candidate.includes(0) && candidate.includes(2),
    { protected: new Set([0]), maxChecks: 40 },
  );

  assert.deepEqual(kept, [0, 2]);
  assert.ok(checks > 0);
});

test("protected segments are never removed", async () => {
  const { kept } = await ddmin([0, 1, 2], async () => true, {
    protected: new Set([1]),
    maxChecks: 10,
  });

  assert.ok(kept.includes(1));
  assert.equal(kept.length, 1);
});

test("ddmin respects the check budget", async () => {
  let calls = 0;
  const { checks } = await ddmin(
    [0, 1, 2, 3],
    async () => {
      calls += 1;
      return false;
    },
    { maxChecks: 3 },
  );

  assert.equal(checks, 3);
  assert.equal(calls, 3);
});

test("a single segment is never reduced to nothing", async () => {
  const { kept, checks } = await ddmin([0], async () => true);
  assert.deepEqual(kept, [0]);
  assert.equal(checks, 0);
});
