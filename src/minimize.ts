export type MinimizeTest = (indices: number[]) => boolean | Promise<boolean>;

export interface MinimizeOptions {
  protected?: ReadonlySet<number>;
  maxChecks?: number;
}

export interface MinimizeResult {
  kept: number[];
  checks: number;
}

/**
 * Delta debugging (ddmin) over prompt segments. The predicate decides whether
 * a candidate still reproduces the divergence; protected segments are never
 * removed and the check budget caps expensive model calls.
 */
export async function ddmin(
  indices: readonly number[],
  test: MinimizeTest,
  options: MinimizeOptions = {},
): Promise<MinimizeResult> {
  const protectedSet = options.protected ?? new Set<number>();
  const maxChecks = options.maxChecks ?? 30;
  const floor = Math.max(protectedSet.size, 1);
  let kept = [...indices];
  let chunks = 2;
  let checks = 0;

  while (kept.length > floor && checks < maxChecks) {
    const chunkSize = Math.max(1, Math.floor(kept.length / chunks));
    const partition: number[][] = [];

    for (let i = 0; i < kept.length; i += chunkSize) {
      partition.push(kept.slice(i, i + chunkSize));
    }

    let reduced = false;

    for (const chunk of partition) {
      if (chunk.some((index) => protectedSet.has(index))) continue;

      const removed = new Set(chunk);
      const candidate = kept.filter((index) => !removed.has(index));
      if (candidate.length === 0) continue;

      checks += 1;
      if (await test(candidate)) {
        kept = candidate;
        chunks = Math.max(chunks - 1, 2);
        reduced = true;
        break;
      }

      if (checks >= maxChecks) break;
    }

    if (!reduced) {
      if (chunks >= kept.length) break;
      chunks = Math.min(chunks * 2, kept.length);
    }
  }

  return { kept, checks };
}
