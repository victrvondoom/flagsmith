/** Wilson score interval for a proportion. */
export function wilson(successes: number, n: number, z: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/**
 * Newcombe hybrid-score lower bound for (pTreatment - pBaseline).
 * Stays well-behaved when counts are zero, unlike a Wald interval.
 */
export function differenceLowerBound(
  tSuccess: number,
  tN: number,
  cSuccess: number,
  cN: number,
  z: number,
): number {
  const pt = tSuccess / tN;
  const pc = cSuccess / cN;
  const wt = wilson(tSuccess, tN, z);
  const wc = wilson(cSuccess, cN, z);
  return pt - pc - Math.sqrt((pt - wt.lower) ** 2 + (wc.upper - pc) ** 2);
}

/** Nearest-rank percentile (deterministic, no interpolation). */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] ?? null;
}
