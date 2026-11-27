import type { Belief, Hypothesis, ProbeDesign, Suspect } from "./types.ts";

/**
 * Probabilistic bisection over flag changes.
 *
 * Hypothesis space: "none of these changes" (H0), each single change (Hi), and optionally each pair of changes that only
 * fails together (Hij). A probe reverts a set R of changes for a small canary cohort. Under Hi the canary heals iff
 * i is in R; under Hij it heals iff i or j is in R (removing either half breaks the interaction); under H0 it never heals.
 *
 * Each probe outcome is treated as a noisy channel with error rate `epsilon` (a wrong call by the per-probe test), and
 * the belief is updated with Bayes' rule. The next R maximises expected information gain (the Bayesian version of
 * group testing; with one culprit, uniform priors and epsilon = 0 it reduces to plain binary search). Everything is
 * deterministic: ties break on smaller R, then lexicographic order.
 */

export interface PriorOptions {
  /** Prior mass on "none of these changes caused it". */
  noneMass?: number;
  /** Total prior mass spread over pair interactions (0 disables pairs). */
  pairMass?: number;
  /** Decay constant in ms for "how long before the onset was the change made". */
  recencyTauMs?: number;
}

export interface PriorExplanation { id: string; weight: number; factors: { recency: number; blastRadius: number; afterOnset: boolean } }

const keyOf = (h: Hypothesis): string => (h.kind === "none" ? "none" : h.ids.join("+"));

/** Evidence-based priors: recent changes before the onset weigh more; changes after the onset cannot explain it. */
export function priors(suspects: Suspect[], onsetMs: number, o: PriorOptions = {}): { beliefs: Belief[]; explanation: PriorExplanation[] } {
  if (suspects.length === 0) return { beliefs: [{ hypothesis: { kind: "none" }, key: "none", p: 1 }], explanation: [] };
  const noneMass = o.noneMass ?? 0.08;
  const pairMass = suspects.length > 1 ? (o.pairMass ?? 0.12) : 0;
  const tau = o.recencyTauMs ?? 20 * 60_000;
  const explanation = suspects.map((s) => {
    const lag = onsetMs - s.changedAt;
    const afterOnset = lag < 0;
    // A change shortly after a detected onset can still be the cause if the onset estimate is early; keep it small, not zero.
    const recency = afterOnset ? 0.03 : Math.exp(-lag / tau);
    const blast = 0.5 + 0.5 * Math.min(1, Math.max(0, s.blastRadius));
    return { id: s.id, weight: Math.max(1e-6, recency * blast), factors: { recency, blastRadius: blast, afterOnset } };
  });
  const total = explanation.reduce((a, e) => a + e.weight, 0);
  const single = new Map(explanation.map((e) => [e.id, e.weight / total]));
  const beliefs: Belief[] = [{ hypothesis: { kind: "none" }, key: "none", p: noneMass }];
  for (const s of suspects) beliefs.push({ hypothesis: { kind: "single", ids: [s.id] }, key: s.id, p: (1 - noneMass - pairMass) * single.get(s.id)! });
  if (pairMass > 0) {
    const pairs: { ids: [string, string]; w: number }[] = [];
    for (let i = 0; i < suspects.length; i++) for (let j = i + 1; j < suspects.length; j++) {
      const a = suspects[i]!.id, b = suspects[j]!.id;
      pairs.push({ ids: [a, b].sort() as [string, string], w: Math.sqrt(single.get(a)! * single.get(b)!) });
    }
    const pw = pairs.reduce((a, p) => a + p.w, 0);
    for (const p of pairs) beliefs.push({ hypothesis: { kind: "pair", ids: p.ids }, key: keyOf({ kind: "pair", ids: p.ids }), p: pairMass * (p.w / pw) });
  }
  return { beliefs: normalise(beliefs), explanation };
}

export function heals(h: Hypothesis, revert: ReadonlySet<string>): boolean {
  if (h.kind === "none") return false;
  return h.ids.some((id) => revert.has(id));
}

function normalise(b: Belief[]): Belief[] {
  const t = b.reduce((a, x) => a + x.p, 0);
  return t > 0 ? b.map((x) => ({ ...x, p: x.p / t })) : b;
}

/** Bayes update after a probe. `inconclusive` leaves the belief unchanged; `harmful` is handled by the Guardian, not here. */
export function update(beliefs: Belief[], revert: string[], verdict: "healed" | "not_healed" | "inconclusive", epsilon = 0.05): Belief[] {
  if (verdict === "inconclusive") return beliefs;
  const r = new Set(revert);
  return normalise(beliefs.map((b) => {
    const h = heals(b.hypothesis, r);
    const like = verdict === "healed" ? (h ? 1 - epsilon : epsilon) : (h ? epsilon : 1 - epsilon);
    return { ...b, p: b.p * like };
  }));
}

const H2 = (p: number): number => (p <= 0 || p >= 1 ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p));

/** Expected information gain (bits) of reverting `revert`: mutual information between the hypothesis and a noisy binary outcome. */
export function expectedGain(beliefs: Belief[], revert: ReadonlySet<string>, epsilon: number): { gain: number; healMass: number } {
  let m = 0;
  for (const b of beliefs) if (heals(b.hypothesis, revert)) m += b.p;
  const pHealed = m * (1 - epsilon) + (1 - m) * epsilon;
  return { gain: H2(pHealed) - H2(epsilon), healMass: m };
}

export interface DesignOptions { epsilon?: number; maxRevert?: number; exclude?: ReadonlySet<string>; enumerateUpTo?: number }

/**
 * Picks the next set of changes to revert for the canary. Exhaustive over subsets when there are at most
 * `enumerateUpTo` suspects (default 14, i.e. 16k subsets); greedy above that.
 */
export function designProbe(beliefs: Belief[], suspects: Suspect[], o: DesignOptions = {}): ProbeDesign | null {
  const eps = o.epsilon ?? 0.05;
  const ids = suspects.map((s) => s.id).filter((id) => !o.exclude?.has(id)).sort();
  if (ids.length === 0) return null;
  const maxRevert = Math.max(1, Math.min(o.maxRevert ?? ids.length, ids.length));
  let best: { set: string[]; gain: number; heal: number } | null = null;
  const better = (set: string[], gain: number): boolean => {
    if (!best) return true;
    if (gain > best.gain + 1e-12) return true;
    if (Math.abs(gain - best.gain) <= 1e-12) {
      if (set.length !== best.set.length) return set.length < best.set.length;
      return set.join(",") < best.set.join(",");
    }
    return false;
  };
  if (ids.length <= (o.enumerateUpTo ?? 14)) {
    const n = ids.length;
    for (let mask = 1; mask < 1 << n; mask++) {
      const set: string[] = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) set.push(ids[i]!);
      if (set.length > maxRevert) continue;
      const { gain, healMass } = expectedGain(beliefs, new Set(set), eps);
      if (better(set, gain)) best = { set, gain, heal: healMass };
    }
  } else {
    // Greedy: add the suspect that raises the gain most, while it does.
    const set: string[] = [];
    let cur = 0;
    for (;;) {
      let pick: string | null = null, pickGain = cur;
      for (const id of ids) {
        if (set.includes(id) || set.length >= maxRevert) continue;
        const g = expectedGain(beliefs, new Set([...set, id]), eps).gain;
        if (g > pickGain + 1e-12) { pick = id; pickGain = g; }
      }
      if (!pick) break;
      set.push(pick); cur = pickGain;
    }
    if (set.length) best = { set: set.sort(), gain: cur, heal: expectedGain(beliefs, new Set(set), eps).healMass };
  }
  if (!best || best.gain <= 1e-9) return null;
  const chosen: { set: string[]; gain: number; heal: number } = best;
  return { revert: chosen.set, expectedGainBits: chosen.gain, healMass: chosen.heal };
}

export interface Conclusion { status: "identified" | "not_a_flag_change" | "undecided"; top: Belief; confidence: number }

export function conclude(beliefs: Belief[], threshold = 0.95): Conclusion {
  const top = [...beliefs].sort((a, b) => b.p - a.p || a.key.localeCompare(b.key))[0]!;
  if (top.p >= threshold) return { status: top.hypothesis.kind === "none" ? "not_a_flag_change" : "identified", top, confidence: top.p };
  return { status: "undecided", top, confidence: top.p };
}

/** Marginal probability that each suspect is involved (alone or as half of a pair). */
export function involvement(beliefs: Belief[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of beliefs) if (b.hypothesis.kind !== "none") for (const id of b.hypothesis.ids) out[id] = (out[id] ?? 0) + b.p;
  return out;
}

export { keyOf as hypothesisKey };
