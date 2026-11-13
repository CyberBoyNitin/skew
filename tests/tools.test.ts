import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/core.ts";
import { formatToolOutput, parseToolArguments } from "../src/tools.ts";

test("tool arguments are parsed without losing invalid JSON", () => {
  assert.deepEqual(parseToolArguments('{"email":"ada@example.com"}'), {
    email: "ada@example.com",
  });
  assert.deepEqual(parseToolArguments(""), {});
  assert.equal(parseToolArguments("{not json"), "{not json");
});

test("unsafe integers in tool arguments stay lossless", () => {
  const parsed = parseToolArguments('{"amount":9007199254740993}');
  assert.deepEqual(parsed, {
    amount: { "$skew.bigint": "9007199254740993" },
  });
});

test("adjacent unsafe integers in tool arguments are semantic", () => {
  const a = formatToolOutput(null, [
    { name: "credit", arguments: parseToolArguments('{"amount":9007199254740993}') },
  ]);
  const b = formatToolOutput(null, [
    { name: "credit", arguments: parseToolArguments('{"amount":9007199254740992}') },
  ]);

  assert.equal(analyze([a!], [b!])?.verdict, "semantic");
});

test("tool calls are normalized into one canonical envelope", () => {
  const output = formatToolOutput(null, [
    { name: "lookup_customer", arguments: { email: "ada@example.com" } },
  ]);

  assert.deepEqual(JSON.parse(output!), {
    tool_calls: [
      { name: "lookup_customer", arguments: { email: "ada@example.com" } },
    ],
  });
});

test("same tool calls with different whitespace are format-only", () => {
  const compact = formatToolOutput(null, [
    { name: "issue_refund", arguments: { amount: 49.99, reason: "damaged" } },
  ]);
  const pretty = JSON.stringify(JSON.parse(compact!), null, 2);

  assert.equal(analyze([compact!], [pretty])?.verdict, "format-only");
});

test("different tool arguments are semantic", () => {
  const a = formatToolOutput(null, [
    { name: "issue_refund", arguments: { amount: 49.99 } },
  ]);
  const b = formatToolOutput(null, [
    { name: "issue_refund", arguments: { amount: 5 } },
  ]);

  assert.equal(analyze([a!], [b!])?.verdict, "semantic");
});

test("a prose preamble alongside a tool call is semantic", () => {
  const quiet = formatToolOutput(null, [
    { name: "lookup_customer", arguments: { email: "ada@example.com" } },
  ]);
  const chatty = formatToolOutput("Sure, let me look that up.", [
    { name: "lookup_customer", arguments: { email: "ada@example.com" } },
  ]);

  assert.equal(analyze([quiet!], [chatty!])?.verdict, "semantic");
});
