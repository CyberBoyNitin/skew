import type { ToolSequenceStep } from "./types.ts";

/**
 * Normalize one scripted tool step. A step is exactly one of a static result
 * or an injected error.
 */
export function normalizeToolStep(
  value: unknown,
  label: string,
): ToolSequenceStep {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const hasResult = Object.prototype.hasOwnProperty.call(record, "result");
  const hasError = Object.prototype.hasOwnProperty.call(record, "error");
  if (hasResult === hasError) {
    throw new Error(
      `${label} must contain exactly one of "result" or "error"`,
    );
  }
  return hasResult
    ? { result: record.result }
    : { error: record.error };
}
