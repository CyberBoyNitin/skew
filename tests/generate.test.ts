import test from "node:test";
import assert from "node:assert/strict";
import { generateProbes } from "../src/generate.ts";
import { promptOf } from "../src/probe.ts";

test("generation is deterministic for a given seed", () => {
  assert.deepEqual(
    generateProbes({ count: 4, seed: 11 }),
    generateProbes({ count: 4, seed: 11 }),
  );
});

test("different seeds produce different prompts", () => {
  const a = generateProbes({ count: 1, seed: 1 })[0]!;
  const b = generateProbes({ count: 1, seed: 2 })[0]!;
  assert.notEqual(promptOf(a), promptOf(b));
});

test("protected indices point at real segments", () => {
  for (const probe of generateProbes({ count: 10, seed: 3 })) {
    assert.ok(probe.protected.size > 0);
    for (const index of probe.protected) {
      assert.ok(index >= 0 && index < probe.segments.length);
    }
    assert.ok(promptOf(probe).includes("TASK:"));
  }
});

test("probes cover the edge-case cycle and tag sensitive records", () => {
  const probes = generateProbes({ count: 8, seed: 7 });
  assert.equal(probes.length, 8);
  assert.ok(probes[1]!.tags.includes("edge:bigint"));
  assert.ok(probes[3]!.tags.includes("sensitive"));
  assert.ok(probes[0]!.tags.includes("edge:unicode"));
});

test("rejects invalid counts", () => {
  assert.throws(() => generateProbes({ count: 0 }));
});
