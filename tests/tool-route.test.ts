import test from "node:test";
import assert from "node:assert/strict";
import {
  hasRouteSequence,
  matchToolRoute,
  matchesToolArguments,
  normalizeToolRoutes,
  routeErrorSteps,
} from "../src/tool-route.ts";

test("routes match a recursive subset of call arguments", () => {
  const routes = normalizeToolRoutes(
    {
      refund: [
        {
          when: {
            customer: { id: "cus_1042", tier: "pro" },
            tags: ["damaged", "priority"],
          },
          result: { refund_id: "re_9001" },
        },
        { error: { code: "not_found", retryable: false } },
      ],
    },
    "toolRoutes",
  ).refund!;

  assert.ok(
    matchesToolArguments(
      { customer: { id: "cus_1042" } },
      {
        customer: { id: "cus_1042", tier: "pro", email: "ada@example.com" },
        extra: true,
      },
    ),
  );
  assert.ok(
    matchesToolArguments(
      { tags: ["damaged", "priority"] },
      { tags: ["damaged", "priority"] },
    ),
  );
  assert.equal(
    matchesToolArguments(
      { customer: { id: "cus_1042", tier: "pro" } },
      { customer: { id: "cus_1042" } },
    ),
    false,
  );
  assert.equal(
    matchesToolArguments(
      { tags: ["damaged"] },
      { tags: ["damaged", "priority"] },
    ),
    false,
  );

  const exact = matchToolRoute(routes, {
    customer: { id: "cus_1042", tier: "pro", email: "ada@example.com" },
    tags: ["damaged", "priority"],
    reason: "damaged in transit",
  });
  assert.equal(exact?.index, 0);
  assert.deepEqual(exact?.route, {
    when: {
      customer: { id: "cus_1042", tier: "pro" },
      tags: ["damaged", "priority"],
    },
    result: { refund_id: "re_9001" },
  });

  const fallback = matchToolRoute(routes, { customer: { id: "cus_9999" } });
  assert.equal(fallback?.index, 1);
  assert.deepEqual(fallback?.route, {
    error: { code: "not_found", retryable: false },
  });
});

test("routes without a fallback return no match", () => {
  const routes = normalizeToolRoutes(
    {
      get_order: [
        { when: { order_id: "8812" }, result: { status: "delivered" } },
      ],
    },
    "toolRoutes",
  ).get_order!;

  assert.equal(matchToolRoute(routes, { order_id: "9999" }), undefined);
  assert.equal(matchToolRoute(routes, "{not json"), undefined);
});

test("route normalization rejects ambiguous and malformed routes", () => {
  assert.throws(
    () => normalizeToolRoutes({ tool: [] }, "toolRoutes"),
    /toolRoutes\.tool must be a non-empty array/,
  );

  assert.throws(
    () => normalizeToolRoutes({ tool: [{}] }, "toolRoutes"),
    /exactly one of "result", "error", or "sequence"/,
  );

  assert.throws(
    () =>
      normalizeToolRoutes(
        { tool: [{ result: {}, error: {} }] },
        "toolRoutes",
      ),
    /exactly one of "result", "error", or "sequence"/,
  );

  assert.throws(
    () =>
      normalizeToolRoutes(
        { tool: [{ when: {}, result: {} }] },
        "toolRoutes",
      ),
    /when must not be empty/,
  );

  assert.throws(
    () =>
      normalizeToolRoutes(
        { tool: [{ sequence: [] }] },
        "toolRoutes",
      ),
    /sequence must be a non-empty array/,
  );

  assert.throws(
    () =>
      normalizeToolRoutes(
        {
          tool: [
            { result: { fallback: true } },
            { when: { id: "x" }, result: {} },
          ],
        },
        "toolRoutes",
      ),
    /fallback route must be last/,
  );

  assert.throws(
    () =>
      normalizeToolRoutes(
        {
          tool: [
            { result: { first: true } },
            { result: { second: true } },
          ],
        },
        "toolRoutes",
      ),
    /at most one fallback route/,
  );

  assert.throws(
    () =>
      normalizeToolRoutes(
        { tool: [{ sequence: [{ result: "ok", error: "boom" }] }] },
        "toolRoutes",
      ),
    /exactly one of "result" or "error"/,
  );
});

test("route sequences expose their error steps", () => {
  const routes = normalizeToolRoutes(
    {
      status: [
        {
          when: { refund_id: "re_7781" },
          sequence: [
            { result: { status: "pending" } },
            { error: { code: "not_ready" } },
            { result: { status: "approved" } },
          ],
        },
      ],
    },
    "toolRoutes",
  ).status!;
  const route = routes[0]!;

  assert.equal(hasRouteSequence(route), true);
  assert.equal(routeErrorSteps(route), 1);
});
