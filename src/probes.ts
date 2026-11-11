import { readFile } from "node:fs/promises";
import { generateProbes } from "./generate.ts";
import type { Probe } from "./probe.ts";

export interface ProbeSpec {
  id: string;
  prompt?: string;
  segments?: string[];
  protected?: number[];
  tags?: string[];
}

export interface LoadProbesOptions {
  generated: number;
  seed: number;
  custom?: ProbeSpec[];
  files?: string[];
}

/**
 * Combine generated probes with user-supplied ones. Custom probes can be
 * inlined in config or loaded from JSON/JSONL files.
 */
export async function loadProbes(
  options: LoadProbesOptions,
): Promise<Probe[]> {
  const probes: Probe[] =
    options.generated > 0
      ? generateProbes({ count: options.generated, seed: options.seed })
      : [];

  for (const spec of options.custom ?? []) {
    probes.push(probeFromSpec(spec));
  }

  for (const file of options.files ?? []) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      throw new Error(
        `cannot read probe file ${file}: ${(error as Error).message}`,
      );
    }
    for (const spec of parseProbeFile(raw, file)) {
      probes.push(probeFromSpec(spec));
    }
  }

  const ids = new Set<string>();
  for (const probe of probes) {
    if (ids.has(probe.id)) {
      throw new Error(`duplicate probe id: ${probe.id}`);
    }
    ids.add(probe.id);
  }

  if (probes.length === 0) {
    throw new Error("no probes loaded: add generated probes or custom probes");
  }

  return probes;
}

export function probeFromSpec(spec: ProbeSpec): Probe {
  const segments =
    spec.segments ?? spec.prompt?.split(/\r?\n/) ?? [];

  if (segments.length === 0) {
    throw new Error(`probe "${spec.id}": prompt must not be empty`);
  }

  const protectedIndices = spec.protected ?? [0];
  for (const index of protectedIndices) {
    if (index < 0 || index >= segments.length) {
      throw new Error(
        `probe "${spec.id}": protected index ${index} is outside 0..${segments.length - 1}`,
      );
    }
  }

  return {
    id: spec.id,
    segments: [...segments],
    protected: new Set(protectedIndices),
    tags: spec.tags ? [...spec.tags] : [],
  };
}

export function normalizeProbeSpec(
  input: unknown,
  label = "probe",
): ProbeSpec {
  const record = asRecord(input, label);

  const id = record.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(`${label}.id must be a non-empty string`);
  }

  const prompt = record.prompt;
  const segments = record.segments;
  const hasPrompt = prompt !== undefined;
  const hasSegments = segments !== undefined;

  if (hasPrompt === hasSegments) {
    throw new Error(`${label} must define exactly one of "prompt" or "segments"`);
  }

  if (hasPrompt && (typeof prompt !== "string" || prompt.trim() === "")) {
    throw new Error(`${label}.prompt must be a non-empty string`);
  }

  let segmentList: string[] | undefined;
  if (hasSegments) {
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error(`${label}.segments must be a non-empty array`);
    }
    segmentList = segments.map((segment, index) => {
      if (typeof segment !== "string") {
        throw new Error(`${label}.segments[${index}] must be a string`);
      }
      return segment;
    });
  }

  const protectedIndices = optionalIntegerArray(
    record.protected,
    `${label}.protected`,
  );
  if (protectedIndices) {
    const length = segmentList?.length ??
      (typeof prompt === "string" ? prompt.split(/\r?\n/).length : 0);
    for (const index of protectedIndices) {
      if (index < 0 || index >= length) {
        throw new Error(
          `${label}.protected contains ${index}, outside 0..${length - 1}`,
        );
      }
    }
  }

  const tags = optionalStringArray(record.tags, `${label}.tags`);

  return {
    id,
    ...(typeof prompt === "string" ? { prompt } : {}),
    ...(segmentList ? { segments: segmentList } : {}),
    ...(protectedIndices ? { protected: protectedIndices } : {}),
    ...(tags ? { tags } : {}),
  };
}

function parseProbeFile(raw: string, file: string): ProbeSpec[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];

  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${file}: invalid JSON: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${file}: expected a JSON array of probes`);
    }
    return parsed.map((item, index) =>
      normalizeProbeSpec(item, `${file}[${index}]`),
    );
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return [normalizeProbeSpec(parsed, file)];
    }
  } catch {
    // Not a single JSON document; fall through to JSONL.
  }

  const specs: ProbeSpec[] = [];
  const lines = trimmed.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${file}:${index + 1}: invalid JSON: ${(error as Error).message}`,
      );
    }
    specs.push(normalizeProbeSpec(parsed, `${file}:${index + 1}`));
  });

  return specs;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalIntegerArray(
  value: unknown,
  label: string,
): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of integers`);
  }
  return value.map((item, index) => {
    if (!Number.isInteger(item)) {
      throw new Error(`${label}[${index}] must be an integer`);
    }
    return item as number;
  });
}

function optionalStringArray(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`${label}[${index}] must be a non-empty string`);
    }
    return item;
  });
}
