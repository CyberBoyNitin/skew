import { createHash } from "node:crypto";
import type {
  DivergenceVerdict,
  PairAnalysis,
  Verdict,
} from "./types.ts";

export const STABLE_THRESHOLD = 0.8;

export const SEVERITY: Record<DivergenceVerdict, number> = {
  "format-only": 1,
  semantic: 2,
  safety: 3,
};

const FENCE_RE = /```(?:json|JSON)?\s*([\s\S]*?)```/;
const SAFETY_RE =
  /\b(?:i can(?:'|’)t|i cannot|i won(?:'|’)t|i will not|i(?:'|’)m sorry|i am sorry|unable to comply|must decline|can(?:'|’)t help with|cannot help with|not able to assist|cannot assist|can(?:'|’)t assist)\b/i;
const WORD_RE = /[a-z0-9_]+/g;
const BIGINT_KEY = "$skew.bigint";

type JsonResult = { ok: true; value: unknown } | { ok: false };

function isBigIntTag(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === BIGINT_KEY &&
    typeof (value as Record<string, unknown>)[BIGINT_KEY] === "string"
  );
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "object":
      break;
    default:
      return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isBigIntTag(value)) {
    return value[BIGINT_KEY]!;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function stripFences(text: string): string {
  const match = FENCE_RE.exec(text);
  return match?.[1]?.trim() ?? text.trim();
}

function losslessReviver(
  _key: string,
  value: unknown,
  context?: { source?: string },
): unknown {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  ) {
    const source = context?.source;
    if (typeof source === "string" && /^-?\d+$/.test(source)) {
      return { [BIGINT_KEY]: source };
    }
  }
  return value;
}

function tryParse(text: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(text, losslessReviver) };
  } catch {
    return { ok: false };
  }
}

export function parseJson(text: string): JsonResult {
  const candidate = stripFences(text);
  const direct = tryParse(candidate);
  if (direct.ok) return direct;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return tryParse(candidate.slice(start, end + 1));
  }
  return { ok: false };
}

export function canonical(text: string): string {
  const parsed = parseJson(text);
  if (parsed.ok) return stableStringify(parsed.value);
  return text.replace(/\s+/g, " ").trim();
}

interface Modal {
  text: string;
  stability: number;
}

function modal(outputs: readonly string[]): Modal {
  const counts = new Map<string, { count: number; text: string }>();

  for (const output of outputs) {
    const key = canonical(output);
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(key, { count: 1, text: output });
    }
  }

  let best: { key: string; count: number; text: string } | undefined;
  for (const [key, entry] of counts) {
    if (
      best === undefined ||
      entry.count > best.count ||
      (entry.count === best.count && key > best.key)
    ) {
      best = { key, ...entry };
    }
  }

  return {
    text: best!.text,
    stability: best!.count / outputs.length,
  };
}

/**
 * Compare two stacks' trial outputs. Returns null when one side produced no
 * successful calls, so the pair cannot be compared.
 */
export function analyze(
  outputsA: readonly string[],
  outputsB: readonly string[],
  threshold = STABLE_THRESHOLD,
): PairAnalysis | null {
  if (outputsA.length === 0 || outputsB.length === 0) return null;

  const a = modal(outputsA);
  const b = modal(outputsB);

  let verdict: Verdict | null;
  if (a.stability < threshold || b.stability < threshold) {
    verdict = "unstable";
  } else if (a.text.trim() === b.text.trim()) {
    verdict = null;
  } else if (canonical(a.text) === canonical(b.text)) {
    verdict = "format-only";
  } else if (SAFETY_RE.test(a.text) || SAFETY_RE.test(b.text)) {
    verdict = "safety";
  } else {
    verdict = "semantic";
  }

  return {
    verdict,
    stabilityA: a.stability,
    stabilityB: b.stability,
    modalA: a.text,
    modalB: b.text,
  };
}

export function severityFor(verdict: DivergenceVerdict): number {
  return SEVERITY[verdict];
}

/**
 * Cluster findings by the tokens that differ between the two outputs. Two
 * probes that trigger the same underlying disagreement collapse into one
 * cluster even when their prompts are different.
 */
export function signature(
  verdict: Verdict,
  outputA: string,
  outputB: string,
): string {
  const fingerprint =
    verdict === "format-only"
      ? "format-only"
      : differenceFingerprint(verdict, outputA, outputB);
  const digest = createHash("sha1")
    .update(fingerprint)
    .digest("hex")
    .slice(0, 10);

  return `${verdict}-${digest}`;
}

/**
 * Describe *what* differs, ignoring everything the two outputs agree on. This
 * is what minimization must preserve: a reduced prompt may change incidental
 * fields, but it has to reproduce the same disagreement.
 */
export function differenceFingerprint(
  verdict: Verdict,
  outputA: string,
  outputB: string,
): string {
  if (verdict === "format-only") {
    const a = parseJson(outputA);
    const b = parseJson(outputB);
    if (!a.ok || !b.ok) return "format-only";
    const digest = createHash("sha1")
      .update(stableStringify(a.value))
      .digest("hex")
      .slice(0, 10);
    return `format-only:json:${digest}`;
  }
  if (verdict === "safety") return "safety";
  if (verdict === "unstable") return "unstable";

  const a = parseJson(outputA);
  const b = parseJson(outputB);
  if (a.ok && b.ok) {
    const diff = collectDiff(a.value, b.value);
    if (diff.length > 0) return `json:${diff.join(";")}`;
  }

  const tokensA = new Set(canonical(outputA).toLowerCase().match(WORD_RE) ?? []);
  const tokensB = new Set(canonical(outputB).toLowerCase().match(WORD_RE) ?? []);
  const tokens: string[] = [];
  for (const token of tokensA) {
    if (!tokensB.has(token)) tokens.push(token);
  }
  for (const token of tokensB) {
    if (!tokensA.has(token)) tokens.push(token);
  }
  tokens.sort();

  return `text:${tokens.join(" ")}`;
}

function collectDiff(
  a: unknown,
  b: unknown,
  path = "$",
  out: string[] = [],
): string[] {
  if (stableStringify(a) === stableStringify(b)) return out;

  const aObject =
    typeof a === "object" && a !== null && !Array.isArray(a) && !isBigIntTag(a);
  const bObject =
    typeof b === "object" && b !== null && !Array.isArray(b) && !isBigIntTag(b);

  if (aObject && bObject) {
    const recordA = a as Record<string, unknown>;
    const recordB = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(recordA), ...Object.keys(recordB)])]
      .sort();

    for (const key of keys) {
      const inA = key in recordA;
      const inB = key in recordB;
      if (!inA) {
        out.push(`${path}.${key}:missing=${stableStringify(recordB[key])}`);
      } else if (!inB) {
        out.push(`${path}.${key}=${stableStringify(recordA[key])}:missing`);
      } else {
        collectDiff(recordA[key], recordB[key], `${path}.${key}`, out);
      }
    }
    return out;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      if (i >= a.length) {
        out.push(`${path}[${i}]:missing=${stableStringify(b[i])}`);
      } else if (i >= b.length) {
        out.push(`${path}[${i}]=${stableStringify(a[i])}:missing`);
      } else {
        collectDiff(a[i], b[i], `${path}[${i}]`, out);
      }
    }
    return out;
  }

  out.push(`${path}=${stableStringify(a)}|${stableStringify(b)}`);
  return out;
}
