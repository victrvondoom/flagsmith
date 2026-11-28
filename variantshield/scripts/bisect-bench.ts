/**
 * Reproducible benchmark of the bisection planner on seeded synthetic incidents (SIMULATION).
 *   node scripts/bisect-bench.ts [--seeds 200]
 * Compares the Bayesian planner with testing one change at a time (same judge, same traffic per probe).
 */
import { simulateBisection, type Hypothesis, type Suspect } from "../packages/bisect/src/index.ts";

const N = Number(process.argv[process.argv.indexOf("--seeds") + 1] || 200);
const MIN = 60_000, ONSET = 1_000 * MIN;
const mk = (n: number, seed: number): Suspect[] => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, feature: `flag_${i}`, before: { enabled: false, value: null }, after: { enabled: true, value: null }, changedAt: ONSET - (3 + ((i * 7 + seed) % 30)) * MIN, changedBy: "ops", blastRadius: 1 }));

function oneAtATime(n: number, truth: Hypothesis): number {
  // Probes needed to name the culprit by reverting one change per probe, in recency order (best case for this baseline).
  if (truth.kind === "none") return n;
  return Math.min(...truth.ids.map((id) => Number(id.slice(1)) + 1));
}

for (const [label, n, kind] of [["single culprit, 8 changes", 8, "single"], ["single culprit, 12 changes", 12, "single"], ["pair that only breaks together, 8 changes", 8, "pair"], ["not a flag change, 8 changes", 8, "none"]] as const) {
  let correct = 0, rounds = 0, worst = 0, canary = 0, seq = 0;
  for (let seed = 1; seed <= N; seed++) {
    const s = mk(n, seed);
    const a = seed % n, b = (seed * 3 + 1) % n === a ? (a + 1) % n : (seed * 3 + 1) % n;
    const truth: Hypothesis = kind === "none" ? { kind: "none" } : kind === "single" ? { kind: "single", ids: [`c${a}`] } : { kind: "pair", ids: [`c${a}`, `c${b}`].sort() as [string, string] };
    const r = simulateBisection({ suspects: s, truth, onsetMs: ONSET, baselineRate: 0.01, faultRate: 0.08, requestsPerRound: 3000, canaryFraction: 0.1, seed, maxRounds: 14 });
    if (r.correct) correct++;
    rounds += r.rounds; worst = Math.max(worst, r.rounds); canary += r.canaryRequests; seq += oneAtATime(n, truth);
  }
  console.log(`${label.padEnd(44)} correct ${(100 * correct / N).toFixed(1)}%  mean probes ${(rounds / N).toFixed(2)} (worst ${worst})  one-at-a-time ${kind === "pair" ? "cannot isolate an interaction" : `mean ${(seq / N).toFixed(2)}`}  canary requests/incident ${Math.round(canary / N)}`);
}
