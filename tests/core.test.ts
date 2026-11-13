import test from "node:test";
import assert from "node:assert/strict";
import {
  analyze,
  canonical,
  differenceFingerprint,
  signature,
} from "../src/core.ts";

test("identical outputs produce no divergence", () => {
  assert.equal(analyze(['{"a":1}'], ['{"a":1}'])?.verdict, null);
});

test("formatting-only differences are classified as format-only", () => {
  const fenced = '```json\n{\n  "b": 2,\n  "a": 1\n}\n```';
  assert.equal(analyze(['{"a":1,"b":2}'], [fenced])?.verdict, "format-only");
});

test("different values are semantic", () => {
  assert.equal(
    analyze(['{"value":0.3}'], ['{"value":0.30000000000000004}'])?.verdict,
    "semantic",
  );
});

test("refusals are classified as safety", () => {
  assert.equal(
    analyze(['{"value":1}'], ["I'm sorry, but I can't help with that."])
      ?.verdict,
    "safety",
  );
});

test("unstable stacks are flagged before comparison", () => {
  assert.equal(analyze(["a", "b"], ["c", "c"])?.verdict, "unstable");
});

test("big integers are compared losslessly", () => {
  assert.notEqual(
    canonical('{"value":9007199254740993}'),
    canonical('{"value":9007199254740992}'),
  );
});

test("big integers nested in objects stay lossless", () => {
  assert.notEqual(
    canonical('{"outer":{"id":9007199254740993}}'),
    canonical('{"outer":{"id":9007199254740992}}'),
  );
});

test("empty output sets cannot be compared", () => {
  assert.equal(analyze([], ["x"]), null);
});

test("format-only fingerprints preserve the JSON payload", () => {
  const first = differenceFingerprint(
    "format-only",
    '{"id":1,"value":"alpha"}',
    '{\n  "id": 1,\n  "value": "alpha"\n}',
  );
  const second = differenceFingerprint(
    "format-only",
    '{"id":2,"value":"beta"}',
    '{\n  "id": 2,\n  "value": "beta"\n}',
  );

  assert.notEqual(first, second);
  assert.match(first, /^format-only:json:/);
});

test("format-only signatures stay grouped across payloads", () => {
  const first = signature(
    "format-only",
    '{"id":1,"value":"alpha"}',
    '{\n  "id": 1,\n  "value": "alpha"\n}',
  );
  const second = signature(
    "format-only",
    '{"id":2,"value":"beta"}',
    '{\n  "id": 2,\n  "value": "beta"\n}',
  );

  assert.equal(first, second);
});

test("the disagreement fingerprint ignores fields that agree", () => {
  const first = differenceFingerprint(
    "semantic",
    '{"id":1,"value":9007199254740992}',
    '{"id":1,"value":9007199254740993}',
  );
  const second = differenceFingerprint(
    "semantic",
    '{"id":9,"value":9007199254740992}',
    '{"id":9,"value":9007199254740993}',
  );

  assert.equal(first, second);
});

test("the disagreement fingerprint separates different root causes", () => {
  const bigint = differenceFingerprint(
    "semantic",
    '{"value":9007199254740992}',
    '{"value":9007199254740993}',
  );
  const float = differenceFingerprint(
    "semantic",
    '{"value":0.3}',
    '{"value":0.30000000000000004}',
  );

  assert.notEqual(bigint, float);
});
