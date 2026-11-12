import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeProbeSpec } from "./probes.ts";
import type { ProbeSpec } from "./probes.ts";
import { HttpRunner } from "./runners.ts";
import type { HttpRunnerOptions, Runner } from "./types.ts";

export interface StackConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  temperature?: number;
  timeoutMs?: number;
  maxTokens?: number;
}

export interface SkewConfig {
  seed: number;
  probes: number;
  probeFiles: string[];
  customProbes: ProbeSpec[];
  trials: number;
  minStability: number;
  minimize: boolean;
  maxChecks: number;
  concurrency: number;
  retries: number;
  retryDelayMs: number;
  retryMaxDelayMs: number;
  stacks: StackConfig[];
}

export const DEFAULTS = {
  seed: 7,
  probes: 12,
  trials: 3,
  minStability: 0.8,
  minimize: true,
  maxChecks: 30,
  concurrency: 4,
  retries: 2,
  retryDelayMs: 500,
  retryMaxDelayMs: 8000,
} as const;

export async function loadConfig(filePath: string): Promise<SkewConfig> {
  const resolvedPath = resolve(filePath);
  const raw = await readFile(resolvedPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid JSON in ${filePath}: ${(error as Error).message}`,
    );
  }
  return normalizeConfig(parsed, dirname(resolvedPath));
}

export function normalizeConfig(
  input: unknown,
  baseDir?: string,
): SkewConfig {
  const root = asRecord(input, "config");

  const seed = integerField(root, "seed", DEFAULTS.seed, 0);
  const probes = integerField(root, "probes", DEFAULTS.probes, 0);
  const trials = integerField(root, "trials", DEFAULTS.trials, 1);
  const maxChecks = integerField(root, "maxChecks", DEFAULTS.maxChecks, 1);
  const concurrency = integerField(
    root,
    "concurrency",
    DEFAULTS.concurrency,
    1,
  );
  const retries = integerField(root, "retries", DEFAULTS.retries, 0);
  const retryDelayMs = integerField(
    root,
    "retryDelayMs",
    DEFAULTS.retryDelayMs,
    0,
  );
  const retryMaxDelayMs = integerField(
    root,
    "retryMaxDelayMs",
    DEFAULTS.retryMaxDelayMs,
    0,
  );
  const minStability = numberField(
    root,
    "minStability",
    DEFAULTS.minStability,
    0,
    1,
  );
  const minimize = booleanField(root, "minimize", DEFAULTS.minimize);

  const rawFiles = root.probeFiles;
  let probeFiles: string[] = [];
  if (rawFiles !== undefined) {
    if (!Array.isArray(rawFiles)) {
      throw new Error("config.probeFiles must be an array");
    }
    probeFiles = rawFiles.map((value, index) => {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
          `config.probeFiles[${index}] must be a non-empty string`,
        );
      }
      return baseDir ? resolve(baseDir, value) : value;
    });
  }

  const rawCustom = root.customProbes;
  let customProbes: ProbeSpec[] = [];
  if (rawCustom !== undefined) {
    if (!Array.isArray(rawCustom)) {
      throw new Error("config.customProbes must be an array");
    }
    customProbes = rawCustom.map((value, index) =>
      normalizeProbeSpec(value, `config.customProbes[${index}]`),
    );
  }

  const rawStacks = root.stacks;
  if (!Array.isArray(rawStacks)) {
    throw new Error("config.stacks must be an array");
  }

  const stacks = rawStacks.map((value, index) =>
    normalizeStack(asRecord(value, `config.stacks[${index}]`), index),
  );

  if (stacks.length < 2) {
    throw new Error("config.stacks must contain at least two stacks");
  }

  const names = new Set<string>();
  for (const stack of stacks) {
    if (names.has(stack.name)) {
      throw new Error(`duplicate stack name: ${stack.name}`);
    }
    names.add(stack.name);
  }

  return {
    seed,
    probes,
    probeFiles,
    customProbes,
    trials,
    minStability,
    minimize,
    maxChecks,
    concurrency,
    retries,
    retryDelayMs,
    retryMaxDelayMs,
    stacks,
  };
}

export function buildRunners(config: SkewConfig): Runner[] {
  return config.stacks.map((stack) => {
    let apiKey = stack.apiKey;
    if (apiKey === undefined && stack.apiKeyEnv) {
      apiKey = process.env[stack.apiKeyEnv];
      if (!apiKey) {
        throw new Error(
          `stack "${stack.name}": environment variable ${stack.apiKeyEnv} is not set`,
        );
      }
    }

    const options: HttpRunnerOptions = {
      name: stack.name,
      baseUrl: stack.baseUrl,
      model: stack.model,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(stack.temperature !== undefined
        ? { temperature: stack.temperature }
        : {}),
      ...(stack.timeoutMs !== undefined ? { timeoutMs: stack.timeoutMs } : {}),
      ...(stack.maxTokens !== undefined
        ? { maxTokens: stack.maxTokens }
        : {}),
    };

    return new HttpRunner(options);
  });
}

function normalizeStack(
  record: Record<string, unknown>,
  index: number,
): StackConfig {
  const label = `config.stacks[${index}]`;
  const name = requiredString(record, "name", label);
  const baseUrl = requiredString(record, "baseUrl", label);
  const model = requiredString(record, "model", label);

  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`${label}.baseUrl is not a valid http(s) URL`);
  }

  const apiKey = optionalString(record, "apiKey", label);
  const apiKeyEnv = optionalString(record, "apiKeyEnv", label);
  const temperature = optionalNumber(record, "temperature", label, 0, 2);
  const timeoutMs = optionalInteger(record, "timeoutMs", label, 1);
  const maxTokens = optionalInteger(record, "maxTokens", label, 1);

  return {
    name,
    baseUrl,
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function integerField(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min) {
    throw new Error(`config.${key} must be an integer >= ${min}`);
  }
  return value as number;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`config.${key} must be a number`);
  }
  if (value < min || value > max) {
    throw new Error(`config.${key} must be between ${min} and ${max}`);
  }
  return value;
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`config.${key} must be a boolean`);
  }
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
  min: number,
  max: number,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}.${key} must be a number`);
  }
  if (value < min || value > max) {
    throw new Error(`${label}.${key} must be between ${min} and ${max}`);
  }
  return value;
}

function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
  min: number,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < min) {
    throw new Error(`${label}.${key} must be an integer >= ${min}`);
  }
  return value as number;
}
