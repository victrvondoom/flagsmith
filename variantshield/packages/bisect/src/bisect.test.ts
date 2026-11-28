import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleRatioMismatch, conclude, designProbe, detectOnset, expectedGain, incompleteBeta, involvement, judge, priors, simulateBisection, update, type Hypothesis, type Suspect } from "./index.ts";
import { mulberry32 } from "./simulate.ts";

const MIN = 60_000;
const ONSET = 1_000 * MIN;
const mk = (n: number, lagMinutes: (i: number) => number = (i) => 5 + i): Suspect[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, feature: `flag_${i}`, before: { enabled: false, value: null }, after: { enabled: true, value: null }, changedAt: ONSET - lagMinutes(i) * MIN, changedBy: "ops", blastRadius: 1 }));

test("incompleteBeta__known_values__match_closed_forms", () => {
  assert.ok(Math.abs(incompleteBeta(0.5, 2, 3) - 0.6875) < 1e-10);
  assert.ok(Math.abs(incompleteBeta(0.3, 1, 1) - 0.3) < 1e-12);
  assert.ok(Math.abs(incompleteBeta(0.2, 5, 1) - 0.2 ** 5) < 1e-12);
  assert.ok(Math.abs(incompleteBeta(0.9, 30, 40) + incompleteBeta(0.1, 40, 30) - 1) < 1e-10);
});

test("priors__change_after_onset__weighs_far_less_than_recent_change_before_it", () => {
  const s = mk(3, (i) => [3, 40, -2][i]!);
  const { explanation, beliefs } = priors(s, ONSET);
  const w = Object.fromEntries(explanation.map((e) => [e.id, e.weight]));
  assert.ok(w.s0! > w.s1! && w.s1! > w.s2!);
  assert.ok(Math.abs(beliefs.reduce((a, b) => a + b.p, 0) - 1) < 1e-12);
});

test("designProbe__uniform_single_culprits_no_noise__splits_in_half", () => {
  const s = mk(8, () => 5);
  const { beliefs } = priors(s, ONSET, { pairMass: 0, noneMass: 0 });
  const d = designProbe(beliefs, s, { epsilon: 0 })!;
  assert.equal(d.revert.length, 4);
  assert.ok(Math.abs(d.expectedGainBits - 1) < 1e-9);
});

test("designProbe__maxRevert__never_exceeds_envelope", () => {
  const s = mk(10);
  const d = designProbe(priors(s, ONSET).beliefs, s, { maxRevert: 2 })!;
  assert.ok(d.revert.length <= 2);
});

test("update__healed_then_not_healed__concentrates_on_the_intersection", () => {
  const s = mk(4, () => 5);
  let b = priors(s, ONSET, { pairMass: 0, noneMass: 0 }).beliefs;
  b = update(b, ["s0", "s1"], "healed", 0.01);
  b = update(b, ["s0"], "not_healed", 0.01);
  assert.equal(conclude(b).top.key, "s1");
  assert.ok(conclude(b).confidence > 0.97);
  assert.ok(expectedGain(b, new Set(["s1"]), 0.01).healMass > 0.97);
});

test("judge__verdicts__healed_not_healed_harmful_and_waiting", () => {
  const main = { n: 5000, failures: 500 };
  assert.equal(judge({ n: 400, failures: 6 }, main, 0.01).verdict, "healed");
  assert.equal(judge({ n: 1200, failures: 121 }, main, 0.01).verdict, "not_healed");
  assert.equal(judge({ n: 400, failures: 41 }, main, 0.01).verdict, "inconclusive");
  assert.equal(judge({ n: 400, failures: 80 }, main, 0.01).verdict, "harmful");
  assert.equal(judge({ n: 30, failures: 0 }, main, 0.01).verdict, "inconclusive");
  assert.match(judge({ n: 400, failures: 4 }, { n: 5000, failures: 52 }, 0.01).reason, /no longer visible/);
});

test("detectOnset__step_change__alarms_near_the_true_onset; stationary__no_alarm", () => {
  const rnd = mulberry32(7);
  const buckets = Array.from({ length: 30 }, (_, i) => {
    const p = i >= 18 ? 0.08 : 0.01;
    let f = 0; for (let k = 0; k < 400; k++) if (rnd() < p) f++;
    return { start: i * MIN, n: 400, failures: f };
  });
  const o = detectOnset(buckets);
  assert.ok(o.alarmed);
  assert.ok(Math.abs(o.onsetAt! - 18 * MIN) <= 2 * MIN, `onset ${o.onsetAt! / MIN}`);
  const flat = buckets.slice(0, 18);
  assert.equal(detectOnset(flat).alarmed, false);
});

test("simulateBisection__single_culprit_over_40_seeds__finds_it_in_few_rounds", () => {
  let correct = 0, worstRounds = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const s = mk(8, (i) => 4 + ((i * 7 + seed) % 11));
    const truth: Hypothesis = { kind: "single", ids: [`s${seed % 8}`] };
    const r = simulateBisection({ suspects: s, truth, onsetMs: ONSET, baselineRate: 0.01, faultRate: 0.09, requestsPerRound: 3000, canaryFraction: 0.1, seed });
    if (r.correct) correct++;
    worstRounds = Math.max(worstRounds, r.rounds);
  }
  assert.ok(correct >= 38, `correct ${correct}/40`);
  assert.ok(worstRounds <= 9, `worst ${worstRounds} rounds`);
});

test("simulateBisection__pair_interaction__identifies_both_changes", () => {
  const s = mk(6);
  const truth: Hypothesis = { kind: "pair", ids: ["s1", "s4"] };
  const r = simulateBisection({ suspects: s, truth, onsetMs: ONSET, baselineRate: 0.01, faultRate: 0.1, requestsPerRound: 4000, canaryFraction: 0.1, seed: 3, maxRounds: 14 });
  assert.equal(r.identified, "s1+s4", JSON.stringify(r.trail));
});

test("simulateBisection__regression_not_caused_by_flags__concludes_not_a_flag_change", () => {
  const s = mk(5);
  const r = simulateBisection({ suspects: s, truth: { kind: "none" }, onsetMs: ONSET, baselineRate: 0.01, faultRate: 0.09, requestsPerRound: 3000, canaryFraction: 0.1, seed: 11, maxRounds: 14 });
  assert.equal(r.identified, "none", JSON.stringify(r.trail));
});

test("sampleRatioMismatch__share_far_from_configured__flags_it", () => {
  assert.equal(sampleRatioMismatch(1000, 10000, 0.1).mismatch, false);
  assert.equal(sampleRatioMismatch(1400, 10000, 0.1).mismatch, true);
});

test("judge__healed__reports_recovered_fraction_and_interval", () => {
  const j = judge({ n: 600, failures: 6 }, { n: 6000, failures: 540 }, 0.01);
  assert.equal(j.verdict, "healed");
  assert.ok(j.recovered > 0.85 && j.recovered < 1.1, String(j.recovered));
  assert.ok(j.ciLow > 0 && j.evidence >= 20);
});

test("involvement__pair_mass__counts_toward_both_members", () => {
  const b = [{ hypothesis: { kind: "pair" as const, ids: ["a", "b"] as [string, string] }, key: "a+b", p: 0.6 }, { hypothesis: { kind: "single" as const, ids: ["a"] as [string] }, key: "a", p: 0.4 }];
  assert.deepEqual(involvement(b), { a: 1, b: 0.6 });
});
