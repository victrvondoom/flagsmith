import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dualVerdict, type ExperimentResultSummary } from "./index.ts";
import { evaluate, mergeConfig, type Observation } from "../../guardrail-engine/src/index.ts";
import { generateTraffic } from "../../guardrail-engine/src/fixtures.ts";

const W = 900_000;
const NOW = 1_800_000_000_000;
const cfg = mergeConfig({ windowMs: W });
const t = (v: string, rest = {}, seed = 1, sessions = 1500): Observation[] =>
  generateTraffic({ variantKey: v, sessions, fromMs: NOW - W, toMs: NOW, ...rest }, seed);
const report = (obs: Observation[]) => evaluate(obs, cfg, NOW, ["upi_first"]);
const results = (over: Partial<ExperimentResultSummary> = {}): ExperimentResultSummary => ({
  asOf: "2026-11-23T00:00:00Z", isFinal: false, winner: "upi_first", significant: true, chanceToWin: { upi_first: 0.99 }, lift: "+12%",
  recommendation: "ship", sampleSizeWarning: null, variants: [], ...over,
});
const healthy = [...t("control", {}, 1), ...t("upi_first", {}, 2)];
const unsafe = [...t("control", {}, 1), ...t("upi_first", { paymentFailureRate: 0.1 }, 3)];
const base = { baselineVariant: "control", flagsmithStatus: "running" as const };

describe("dual verdict", () => {
  it("dualVerdict__winner_and_healthy__is_safe_to_continue", () => {
    const v = dualVerdict({ ...base, experiment: results(), guardrails: report(healthy) });
    assert.equal(v.outcome, "WINNER_AND_SAFE");
    assert.equal(v.recommendedAction, "continue");
  });

  it("dualVerdict__winner_with_breach__is_unsafe_and_recommends_pause", () => {
    const v = dualVerdict({ ...base, experiment: results(), guardrails: report(unsafe) });
    assert.equal(v.outcome, "WINNER_BUT_UNSAFE");
    assert.equal(v.recommendedAction, "pause");
    assert.equal(v.requiresHumanApproval, true);
    assert.ok(v.evidence.some((l) => /payment_failure_rate: BREACH/.test(l)));
  });

  it("dualVerdict__breach_but_flagsmith_not_running__does_not_recommend_pause", () => {
    const v = dualVerdict({ ...base, flagsmithStatus: "paused", experiment: results(), guardrails: report(unsafe) });
    assert.equal(v.recommendedAction, "investigate");
  });

  it("dualVerdict__healthy_but_no_significant_winner__is_inconclusive", () => {
    const v = dualVerdict({ ...base, experiment: results({ winner: null, significant: false, sampleSizeWarning: "Fewer than 50 identities" }), guardrails: report(healthy) });
    assert.equal(v.outcome, "HEALTHY_BUT_INCONCLUSIVE");
  });

  it("dualVerdict__too_little_telemetry__is_insufficient_evidence_even_with_winner", () => {
    const v = dualVerdict({ ...base, experiment: results(), guardrails: report([...t("control", {}, 1, 30), ...t("upi_first", {}, 2, 30)]) });
    assert.equal(v.outcome, "INSUFFICIENT_EVIDENCE");
    assert.equal(v.recommendedAction, "collect_more_data");
  });

  it("dualVerdict__flagsmith_results_missing__never_claims_winner", () => {
    const v = dualVerdict({ ...base, experiment: null, guardrails: report(healthy) });
    assert.equal(v.experimentVerdict.state, "UNAVAILABLE");
    assert.equal(v.outcome, "INSUFFICIENT_EVIDENCE");
  });

  it("dualVerdict__warning_level_signal__requires_investigation", () => {
    const warn = [...t("control", { paymentFailureRate: 0.02 }, 1), ...t("upi_first", { paymentFailureRate: 0.035 }, 4)];
    const v = dualVerdict({ ...base, experiment: results(), guardrails: report(warn) });
    assert.equal(v.outcome, "REQUIRES_INVESTIGATION");
  });

  it("dualVerdict__attribution_gap_on_healthy_winner__downgrades_to_investigation", () => {
    const gap = [...healthy, ...t("", {}, 5, 0), ...generateTraffic({ variantKey: null, sessions: 400, fromMs: NOW - W, toMs: NOW }, 6)];
    const v = dualVerdict({ ...base, experiment: results(), guardrails: report(gap) });
    assert.equal(v.outcome, "REQUIRES_INVESTIGATION");
  });

  it("dualVerdict__control_wins_and_treatment_breaches__keeps_baseline", () => {
    const v = dualVerdict({ ...base, experiment: results({ winner: "control" }), guardrails: report(unsafe) });
    assert.equal(v.outcome, "REQUIRES_INVESTIGATION");
    assert.match(v.headline, /Keep the baseline/);
  });

  it("dualVerdict__always__carries_non_causation_caveat", () => {
    const v = dualVerdict({ ...base, experiment: results(), guardrails: report(healthy) });
    assert.ok(v.caveats.some((c) => /causation/.test(c)));
  });
});
