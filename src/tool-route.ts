import { normalizeToolStep } from "./tool-step.ts";
import type { ToolRoute, ToolSequenceStep } from "./types.ts";

/**
 * Normalize an argument-aware route. A route has optional argument matchers
 * plus exactly one response: a static result, a static error, or a sequence.
 */
export function normalizeToolRoute(
  value: unknown,
  label: string,
): ToolRoute {
  const record = asRecord(value, label);

  let when: Record<string, unknown> | undefined;
  if (record.when !== undefined) {
    const matcher = asRecord(record.when, `${label}.when`);
    if (Object.keys(matcher).length === 0) {
      throw new Error(
        `${label}.when must not be empty; omit "when" for a fallback route`,
      );
    }
    when = { ...matcher };
  }

  const hasResult = Object.prototype.hasOwnProperty.call(record, "result");
  const hasError = Object.prototype.hasOwnProperty.call(record, "error");
  const hasSequence = Object.prototype.hasOwnProperty.call(
    record,
    "sequence",
  );
  const responses = [hasResult, hasError, hasSequence].filter(Boolean).length;
  if (responses !== 1) {
    throw new Error(
      `${label} must contain exactly one of "result", "error", or "sequence"`,
    );
  }

  const base = when === undefined ? {} : { when };
  if (hasSequence) {
    const raw = record.sequence;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`${label}.sequence must be a non-empty array`);
    }
    return {
      ...base,
      sequence: raw.map((step, index) =>
        normalizeToolStep(step, `${label}.sequence[${index}]`),
      ),
    };
  }
  if (hasError) return { ...base, error: record.error };
  return { ...base, result: record.result };
}

/**
 * Normalize a tool-name to route-list map. Every list is non-empty, and a
 * fallback route (one without `when`) must be unique and last.
 */
export function normalizeToolRoutes(
  value: unknown,
  label: string,
): Record<string, ToolRoute[]> {
  const record = asRecord(value, label);
  const routes: Record<string, ToolRoute[]> = {};

  for (const [name, raw] of Object.entries(record)) {
    if (name.trim() === "") {
      throw new Error(`${label} contains an empty tool name`);
    }
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`${label}.${name} must be a non-empty array`);
    }
    const normalized = raw.map((item, index) =>
      normalizeToolRoute(item, `${label}.${name}[${index}]`),
    );
    const fallbacks = normalized.flatMap((route, index) =>
      route.when === undefined ? [index] : [],
    );
    if (fallbacks.length > 1) {
      throw new Error(
        `${label}.${name} must have at most one fallback route`,
      );
    }
    if (
      fallbacks.length === 1 &&
      fallbacks[0] !== normalized.length - 1
    ) {
      throw new Error(`${label}.${name} fallback route must be last`);
    }
    routes[name] = normalized;
  }

  return routes;
}

/**
 * Find the first route that matches a tool call. A route matches when every
 * key in `when` is present in the arguments and matches recursively. Extra
 * argument keys are allowed. A route without `when` is a fallback.
 */
export function matchToolRoute(
  routes: readonly ToolRoute[],
  args: unknown,
): { route: ToolRoute; index: number } | undefined {
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index]!;
    if (
      route.when === undefined ||
      matchesToolArguments(route.when, args)
    ) {
      return { route, index };
    }
  }
  return undefined;
}

export function matchesToolArguments(
  expected: unknown,
  actual: unknown,
): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) =>
        matchesToolArguments(item, actual[index]),
      )
    );
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.keys(expected).every(
      (key) =>
        Object.prototype.hasOwnProperty.call(actual, key) &&
        matchesToolArguments(expected[key], actual[key]),
    );
  }

  return expected === actual;
}

export function hasRouteSequence(
  route: ToolRoute,
): route is ToolRoute & { sequence: ToolSequenceStep[] } {
  return "sequence" in route;
}

export function routeErrorSteps(route: ToolRoute): number {
  if (!hasRouteSequence(route)) return 0;
  return route.sequence.filter((step) => "error" in step).length;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
