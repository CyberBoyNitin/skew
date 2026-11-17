import type { ToolSequenceStep } from "./types.ts";

export interface Probe {
  id: string;
  segments: string[];
  protected: Set<number>;
  tags: string[];
  /** User messages sent after each final assistant answer. */
  followUps: string[];
  /** Per-probe static tool overrides, merged over the global environment. */
  toolResults: Record<string, unknown>;
  /** Per-probe scripted tool overrides, merged over the global environment. */
  toolSequences: Record<string, ToolSequenceStep[]>;
}

export function promptOf(probe: Probe): string {
  return probe.segments.join("\n");
}

export function probeWithSegments(probe: Probe, indices: readonly number[]): Probe {
  const segments: string[] = [];
  const protectedIndices = new Set<number>();

  indices.forEach((originalIndex, newIndex) => {
    const segment = probe.segments[originalIndex];
    if (segment === undefined) return;
    segments.push(segment);
    if (probe.protected.has(originalIndex)) protectedIndices.add(newIndex);
  });

  return { ...probe, segments, protected: protectedIndices };
}
