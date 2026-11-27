import { conclude, designProbe, heals, hypothesisKey, priors, update } from "./planner.ts";
import { judge, type JudgeOptions } from "./judge.ts";
import type { Hypothesis, Suspect } from "./types.ts";

/**
 * Closed-loop, seeded simulation of a bisection: synthetic traffic where a hidden culprit hypothesis decides who fails.
 * Used by property tests and by the comparison benchmark. Labelled as simulation wherever it is shown.
 */
export interface SimWorld {
  suspects: Suspect[];
  truth: Hypothesis;
  onsetMs: number;
  baselineRate: number;
  faultRate: number;
  /** Requests per probe round across the whole population. */
  requestsPerRound: number;
  canaryFraction: number;
  maxRounds?: number;
  maxRevert?: number;
  pairs?: boolean;
  seed: number;
  judge?: JudgeOptions;
}

export interface SimResult {
  identified: string | null;
  correct: boolean;
  rounds: number;
  canaryRequests: number;
  /** Requests that hit a reverted (changed) config: the user-facing cost of the investigation. */
  usersOnChangedConfig: number;
  trail: { revert: string[]; verdict: string; canaryRate: number; mainRate: number; topKey: string; topP: number }[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulateBisection(w: SimWorld): SimResult {
  const rnd = mulberry32(w.seed);
  let beliefs = priors(w.suspects, w.onsetMs, w.pairs === false ? { pairMass: 0 } : {}).beliefs;
  const trail: SimResult["trail"] = [];
  let canaryRequests = 0, changed = 0;
  const maxRounds = w.maxRounds ?? 12;
  for (let round = 0; round < maxRounds; round++) {
    const c = conclude(beliefs);
    if (c.status !== "undecided") break;
    const design = designProbe(beliefs, w.suspects, { ...(w.maxRevert ? { maxRevert: w.maxRevert } : {}) });
    if (!design) break;
    const revert = new Set(design.revert);
    const canaryHealed = heals(w.truth, revert);
    const main = { n: 0, failures: 0 }, canary = { n: 0, failures: 0 };
    // Keep sampling the same probe until the judge decides (sequential), up to 4 batches.
    let verdict: "healed" | "not_healed" | "inconclusive" = "inconclusive";
    let last: ReturnType<typeof judge> | null = null;
    for (let batch = 0; batch < 4 && verdict === "inconclusive"; batch++) {
      for (let i = 0; i < w.requestsPerRound; i++) {
        const inCanary = rnd() < w.canaryFraction;
        // Under "none" the regression has another cause and reaches everyone, canary included.
        const faulty = !(inCanary && canaryHealed);
        const fail = rnd() < (faulty ? w.faultRate : w.baselineRate);
        const s = inCanary ? canary : main;
        s.n++; if (fail) s.failures++;
        if (inCanary) { canaryRequests++; changed++; }
      }
      last = judge(canary, main, w.baselineRate, w.judge);
      verdict = last.verdict === "harmful" ? "inconclusive" : last.verdict;
      if (last.verdict === "harmful") break;
    }
    beliefs = update(beliefs, design.revert, verdict);
    const top = [...beliefs].sort((a, b) => b.p - a.p)[0]!;
    trail.push({ revert: design.revert, verdict, canaryRate: last?.canaryRate ?? 0, mainRate: last?.mainRate ?? 0, topKey: top.key, topP: top.p });
  }
  const c = conclude(beliefs);
  const identified = c.status === "undecided" ? null : c.top.key;
  return { identified, correct: identified === hypothesisKey(w.truth), rounds: trail.length, canaryRequests, usersOnChangedConfig: changed, trail };
}
