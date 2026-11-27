import { probRateBelow } from "./beta.ts";
import type { CohortStats, ProbeVerdict } from "./types.ts";

/**
 * Per-probe decision with a plug-in two-sample mixture SPRT (Johari, Pekelis and Walsh, "Always valid inference",
 * arXiv:1512.04922). The canary (changes in R reverted) and the main population (everything as now) run at the same
 * time, so drift in traffic mix hits both arms.
 *
 *   theta = p_main - p_canary            (how much reverting R helps)
 *   Delta = p_main - p_baseline          (the size of the regression)
 *   V     = pC(1-pC)/nC + pM(1-pM)/nM
 *   Lambda = sqrt(V/(V+tau^2)) * exp(tau^2 theta^2 / (2 V (V+tau^2))),  tau = Delta
 *   h     = sqrt(V(V+tau^2)/tau^2 * (2 ln(1/alpha) + ln((V+tau^2)/V)))   (always-valid CI half width)
 *
 *   healed      Lambda >= 1/alpha and theta > 0         (reverting R removes the regression)
 *   not_healed  theta + h < rho * Delta                  (it removes at most a small part of it)
 *   harmful     theta + h < -harmMargin                  (the canary is worse: the Guardian aborts)
 *   inconclusive otherwise, or below minSamples.
 *
 * Validity is asymptotic (plug-in variance). `pBelowMid` is a Beta-posterior read-out for the UI, not the stopping rule.
 */
export interface JudgeOptions { alpha?: number; rho?: number; minSamples?: number; harmMargin?: number; minEffect?: number }

export interface Judgement {
  verdict: ProbeVerdict;
  canaryRate: number; mainRate: number; baselineRate: number;
  theta: number; delta: number; ciLow: number; ciHigh: number; evidence: number; threshold: number;
  /** Fraction of the regression the revert removed (theta / Delta). */
  recovered: number;
  pBelowMid: number;
  reason: string;
}

export function judge(canary: CohortStats, main: CohortStats, baselineRate: number, o: JudgeOptions = {}): Judgement {
  const alpha = o.alpha ?? 0.05, rho = o.rho ?? 0.5, minN = o.minSamples ?? 150, harmMargin = o.harmMargin ?? 0.02, minEffect = o.minEffect ?? 0.01;
  const EPS = 1e-6;
  const rate = (s: CohortStats): number => (s.n > 0 ? s.failures / s.n : 0);
  const canaryRate = rate(canary), mainRate = rate(main);
  const delta = mainRate - baselineRate;
  const theta = mainRate - canaryRate;
  const base = { canaryRate, mainRate, baselineRate, theta, delta, threshold: 1 / alpha, recovered: delta > 0 ? theta / delta : 0, pBelowMid: canary.n ? probRateBelow(Math.max(EPS, (baselineRate + mainRate) / 2), canary.failures, canary.n) : 0 };
  const waiting = (reason: string): Judgement => ({ ...base, verdict: "inconclusive", ciLow: -1, ciHigh: 1, evidence: 0, reason });
  if (main.n < minN) return waiting(`main population has ${main.n} of ${minN} samples`);
  if (delta < minEffect) return waiting(`the regression is no longer visible in the main population (${pct(mainRate)} vs baseline ${pct(baselineRate)})`);
  if (canary.n === 0) return waiting("no canary traffic yet");
  const clamp = (p: number): number => Math.min(1 - EPS, Math.max(EPS, p));
  const pc = clamp(canaryRate), pm = clamp(mainRate);
  const V = (pc * (1 - pc)) / canary.n + (pm * (1 - pm)) / main.n;
  const tau2 = delta * delta;
  const evidence = Math.sqrt(V / (V + tau2)) * Math.exp((tau2 * theta * theta) / (2 * V * (V + tau2)));
  const h = Math.sqrt(((V * (V + tau2)) / tau2) * (2 * Math.log(1 / alpha) + Math.log((V + tau2) / V)));
  const out = { ...base, ciLow: theta - h, ciHigh: theta + h, evidence };
  const ev = `evidence ${fmt(evidence)} of ${fmt(1 / alpha)}; gap ${pp(theta)} ± ${pp(h)}`;
  if (theta + h < -harmMargin) return { ...out, verdict: "harmful", reason: `canary ${pct(canaryRate)} is worse than the main population ${pct(mainRate)} (${ev})` };
  if (canary.n < minN) return { ...out, verdict: "inconclusive", reason: `canary has ${canary.n} of ${minN} samples (${ev})` };
  if (evidence >= 1 / alpha && theta > 0) return { ...out, verdict: "healed", reason: `reverting removes ${Math.round(base.recovered * 100)}% of the regression: canary ${pct(canaryRate)} vs main ${pct(mainRate)} (${ev})` };
  if (theta + h < rho * delta) return { ...out, verdict: "not_healed", reason: `reverting removes less than ${Math.round(rho * 100)}% of the regression: canary ${pct(canaryRate)} vs main ${pct(mainRate)} (${ev})` };
  return { ...out, verdict: "inconclusive", reason: `not decisive yet (${ev})` };
}

/** Sample-ratio check: is the canary's share of traffic consistent with its configured percentage? Chi-square, 1 dof. */
export function sampleRatioMismatch(canaryN: number, totalN: number, expectedShare: number): { chi2: number; mismatch: boolean } {
  if (totalN === 0 || expectedShare <= 0 || expectedShare >= 1) return { chi2: 0, mismatch: false };
  const ec = totalN * expectedShare, em = totalN - ec, mc = totalN - canaryN;
  const chi2 = (canaryN - ec) ** 2 / ec + (mc - em) ** 2 / em;
  return { chi2, mismatch: chi2 > 10.83 }; // p < 0.001
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
const pp = (x: number): string => `${(x * 100).toFixed(2)} pp`;
const fmt = (x: number): string => (x >= 1000 ? x.toExponential(1) : x.toFixed(1));
