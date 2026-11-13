import { parseJson } from "./core.ts";

export interface NormalizedToolCall {
  name: string;
  arguments: unknown;
}

/**
 * OpenAI returns tool arguments as a JSON-encoded string. Anthropic returns
 * them as an object. Normalize both to the parsed value, keeping the raw text
 * when a provider emits invalid JSON so the divergence is still visible.
 * Unsafe integers stay tagged, exactly like ordinary JSON outputs.
 */
export function parseToolArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  const parsed = parseJson(trimmed);
  return parsed.ok ? parsed.value : raw;
}

/**
 * Tool calls are part of the observable behavior, not a separate channel.
 * Serialize them into one canonical envelope so the normal analyzer,
 * minimizer, clustering, and report can compare them without special cases.
 */
export function formatToolOutput(
  text: string | null,
  calls: readonly NormalizedToolCall[],
): string | null {
  if (calls.length === 0) return text;

  const output: Record<string, unknown> = {};
  if (text !== null && text.trim() !== "") output.text = text;
  output.tool_calls = calls.map((call) => ({
    name: call.name,
    arguments: call.arguments,
  }));
  return JSON.stringify(output);
}
