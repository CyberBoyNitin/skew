import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProbes,
  normalizeProbeSpec,
  probeFromSpec,
} from "../src/probes.ts";

test("custom probes protect the first segment by default", () => {
  const probe = probeFromSpec(
    normalizeProbeSpec({ id: "x", prompt: "line one\nline two" }),
  );

  assert.deepEqual(probe.segments, ["line one", "line two"]);
  assert.deepEqual([...probe.protected], [0]);
  assert.deepEqual(probe.tags, []);
  assert.deepEqual(probe.followUps, []);
});

test("follow-up user turns are parsed and preserved", () => {
  const spec = normalizeProbeSpec({
    id: "follow-up",
    prompt: "Look up Ada.",
    followUps: ["Now look up Grace.", "Compare both."],
  });
  assert.deepEqual(spec.followUps, ["Now look up Grace.", "Compare both."]);

  const probe = probeFromSpec(spec);
  assert.deepEqual(probe.followUps, [
    "Now look up Grace.",
    "Compare both.",
  ]);

  assert.throws(
    () =>
      normalizeProbeSpec({
        id: "bad-follow-up",
        prompt: "Look up Ada.",
        followUps: [""],
      }),
    /followUps\[0\] must be a non-empty string/,
  );
});

test("probe tool overrides are parsed and preserved", () => {
  const spec = normalizeProbeSpec({
    id: "tool-overrides",
    prompt: "Check both services.",
    toolResults: { ping: { ok: true } },
    toolSequences: {
      pong: [{ result: { ok: false } }, { error: { code: "timeout" } }],
    },
  });
  assert.deepEqual(spec.toolResults, { ping: { ok: true } });
  assert.deepEqual(spec.toolSequences, {
    pong: [{ result: { ok: false } }, { error: { code: "timeout" } }],
  });

  const probe = probeFromSpec(spec);
  assert.deepEqual(probe.toolResults, { ping: { ok: true } });
  assert.deepEqual(probe.toolSequences, {
    pong: [{ result: { ok: false } }, { error: { code: "timeout" } }],
  });
});

test("probe tool overrides reject ambiguous and malformed scripts", () => {
  assert.throws(
    () =>
      normalizeProbeSpec({
        id: "ambiguous",
        prompt: "Check the service.",
        toolResults: { ping: { ok: true } },
        toolSequences: { ping: [{ result: { ok: true } }] },
      }),
    /defines both toolResults\.ping and toolSequences\.ping/,
  );

  assert.throws(
    () =>
      normalizeProbeSpec({
        id: "empty-sequence",
        prompt: "Check the service.",
        toolSequences: { ping: [] },
      }),
    /toolSequences\.ping must be a non-empty array/,
  );

  assert.throws(
    () =>
      normalizeProbeSpec({
        id: "bad-step",
        prompt: "Check the service.",
        toolSequences: { ping: [{ result: "ok", error: "boom" }] },
      }),
    /must contain exactly one/,
  );
});

test("probe argument-aware routes are parsed and preserved", () => {
  const spec = normalizeProbeSpec({
    id: "tool-routes",
    prompt: "Look up the order.",
    toolRoutes: {
      get_order: [
        {
          when: { order_id: "8812" },
          result: { order_id: "8812", status: "delivered" },
        },
        { error: { code: "not_found", retryable: false } },
      ],
    },
  });
  assert.deepEqual(spec.toolRoutes, {
    get_order: [
      {
        when: { order_id: "8812" },
        result: { order_id: "8812", status: "delivered" },
      },
      { error: { code: "not_found", retryable: false } },
    ],
  });

  const probe = probeFromSpec(spec);
  assert.deepEqual(probe.toolRoutes, spec.toolRoutes);
});

test("probe tool overrides reject route collisions and malformed routes", () => {
  assert.throws(
    () =>
      normalizeProbeSpec({
        id: "ambiguous-result",
        prompt: "Check the service.",
        toolResults: { ping: { ok: true } },
        toolRoutes: { ping: [{ result: { ok: true } }] },
      }),
    /defines both toolResults\.ping and toolRoutes\.ping/,
  );

  assert.throws(
    () =>
      normalizeProbeSpec({
        id: "ambiguous-sequence",
        prompt: "Check the service.",
        toolSequences: { ping: [{ result: { ok: true } }] },
        toolRoutes: { ping: [{ result: { ok: true } }] },
      }),
    /defines both toolSequences\.ping and toolRoutes\.ping/,
  );

  assert.throws(
    () =>
      normalizeProbeSpec({
        id: "bad-route",
        prompt: "Check the service.",
        toolRoutes: {
          ping: [
            { result: {} },
            { when: { id: "x" }, result: {} },
          ],
        },
      }),
    /fallback route must be last/,
  );

  assert.throws(
    () =>
      normalizeProbeSpec({
        id: "bad-route-step",
        prompt: "Check the service.",
        toolRoutes: {
          ping: [{ sequence: [{ result: "ok", error: "boom" }] }],
        },
      }),
    /exactly one of "result" or "error"/,
  );
});

test("segments and protected indices are kept verbatim", () => {
  const probe = probeFromSpec({
    id: "y",
    segments: ["a", "b", "c"],
    protected: [0, 2],
    tags: ["sql"],
  });

  assert.deepEqual([...probe.protected], [0, 2]);
  assert.deepEqual(probe.tags, ["sql"]);
});

test("loadProbes merges generated, inline, and file probes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skew-probes-"));
  const file = join(dir, "extra.jsonl");
  await writeFile(
    file,
    [
      JSON.stringify({ id: "file-1", prompt: "A\nB", tags: ["x"] }),
      JSON.stringify({
        id: "file-2",
        segments: ["one", "two"],
        protected: [],
      }),
    ].join("\n"),
    "utf8",
  );

  const probes = await loadProbes({
    generated: 1,
    seed: 7,
    custom: [{ id: "inline", prompt: "hello" }],
    files: [file],
  });

  assert.equal(probes.length, 4);
  assert.ok(probes[0]!.id.startsWith("p"));
  assert.equal(probes[1]!.id, "inline");
  assert.equal(probes[2]!.id, "file-1");
  assert.equal(probes[3]!.id, "file-2");
  assert.deepEqual([...probes[3]!.protected], []);
});

test("a JSON array probe file is accepted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skew-probes-"));
  const file = join(dir, "probes.json");
  await writeFile(
    file,
    JSON.stringify([
      { id: "a", prompt: "one" },
      { id: "b", prompt: "two" },
    ]),
    "utf8",
  );

  const probes = await loadProbes({
    generated: 0,
    seed: 7,
    files: [file],
  });

  assert.equal(probes.length, 2);
});

test("duplicate ids are rejected", async () => {
  await assert.rejects(
    () =>
      loadProbes({
        generated: 1,
        seed: 7,
        custom: [{ id: "p000", prompt: "collision" }],
      }),
    /duplicate probe id/,
  );
});

test("protected indices are validated", () => {
  assert.throws(
    () => probeFromSpec({ id: "x", prompt: "one", protected: [3] }),
    /protected index 3 is outside/,
  );
});

test("invalid specs are rejected", () => {
  assert.throws(() => normalizeProbeSpec({ id: "x" }), /exactly one/);
  assert.throws(
    () =>
      normalizeProbeSpec({
        id: "x",
        prompt: "one",
        segments: ["two"],
      }),
    /exactly one/,
  );
  assert.throws(
    () => normalizeProbeSpec({ id: "", prompt: "one" }),
    /id must be a non-empty string/,
  );
});
