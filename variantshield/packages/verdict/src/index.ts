import type { GuardrailReport, GuardrailStatus, MetricResult, VariantReport } from "../../guardrail-engine/src/index.ts";
import { worstStatus } from "../../guardrail-engine/src/index.ts";

/** Normalised view of Flagsmith's own experiment results. VariantShield never recomputes these. */
export interface ExperimentResultSummary {
  asOf: string | null;
  isFinal: boolean;
  winner: string | null;
  significant: boolean;
  /** Flagsmith's own probability (0-1) that each treatment beats control, as served. */
  chanceToWin: Record<string, number>;
  lift: string | null;
  recommendation: string | null;
  sampleSizeWarning: string | null;
  variants: { variant: string; evaluations: number; conversions: number; conversionRate: number }[];
}

export type ExperimentVerdictState = "WINNER" | "INCONCLUSIVE" | "UNAVAILABLE";

export type DualOutcome =
  | "WINNER_AND_SAFE"
  | "WINNER_BUT_UNSAFE"
  | "HEALTHY_BUT_INCONCLUSIVE"
  | "INSUFFICIENT_EVIDENCE"
  | "REQUIRES_INVESTIGATION";

export type RecommendedAction = "pause" | "investigate" | "continue" | "collect_more_data";

export interface DualVerdictInput {
  /** Flagsmith results, or null when Flagsmith has not computed them. */
  experiment: ExperimentResultSummary | null;
  guardrails: GuardrailReport;
  /** Status reported by Flagsmith itself (never inferred). */
  flagsmithStatus: "created" | "running" | "paused" | "completed" | "unknown";
  baselineVariant: string;
}

export interface DualVerdict {
  experimentVerdict: {
    state: ExperimentVerdictState;
    winner: string | null;
    source: "flagsmith";
    summary: ExperimentResultSummary | null;
    reason: string;
  };
  reliabilityVerdict: {
    status: GuardrailStatus;
    subjectVariants: string[];
    source: "variantshield-telemetry";
    variants: VariantReport[];
    reason: string;
  };
  outcome: DualOutcome;
  headline: string;
  recommendedAction: RecommendedAction;
  /** Any experiment control action needs explicit human approval; this is always true. */
  requiresHumanApproval: true;
  evidence: string[];
  caveats: string[];
}

function classifyExperiment(r: ExperimentResultSummary | null): DualVerdict["experimentVerdict"] {
  if (!r) {
    return { state: "UNAVAILABLE", winner: null, source: "flagsmith", summary: null, reason: "Flagsmith has not computed results for this experiment yet." };
  }
  if (r.winner && r.significant) {
    return { state: "WINNER", winner: r.winner, source: "flagsmith", summary: r, reason: `Flagsmith reports "${r.winner}" as the winner${r.lift ? ` (lift ${r.lift})` : ""}.` };
  }
  return {
    state: "INCONCLUSIVE", winner: null, source: "flagsmith", summary: r,
    reason: r.sampleSizeWarning ? `Flagsmith: ${r.sampleSizeWarning}` : "Flagsmith reports no statistically significant winner yet.",
  };
}

function metricLine(m: MetricResult): string {
  const f = (v: number | null): string => (v === null ? "n/a" : m.metric === "checkout_p95_latency_ms" ? `${Math.round(v)}ms` : `${(v * 100).toFixed(2)}%`);
  return `${m.metric}: ${m.status}. treatment ${f(m.treatment.value)} (n=${m.treatment.sampleSize}) vs baseline ${f(m.baseline.value)} (n=${m.baseline.sampleSize}). ${m.reason}`;
}

export function dualVerdict(input: DualVerdictInput): DualVerdict {
  const a = classifyExperiment(input.experiment);
  const treatments = input.guardrails.variants;
  const winnerIsTreatment = a.state === "WINNER" && a.winner !== input.baselineVariant;
  const subject = winnerIsTreatment ? treatments.filter((v) => v.variantKey === a.winner) : treatments;
  const status = subject.length > 0 ? worstStatus(subject.map((v) => v.status)) : "INSUFFICIENT_DATA";
  const attributionGap = subject.some((v) => v.dataQuality.flagged);
  const breaching = treatments.filter((v) => v.status === "BREACH").map((v) => v.variantKey);

  const evidence: string[] = [];
  for (const v of subject) for (const m of v.metrics) evidence.push(`[${v.variantKey}] ${metricLine(m)}`);
  const w = subject[0]?.metrics[0];
  if (w) evidence.push(`Observation window: ${new Date(w.windowFromMs).toISOString()} to ${new Date(w.windowToMs).toISOString()}.`);
  if (a.summary) {
    const ctw = Object.entries(a.summary.chanceToWin).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join(", ") || "n/a";
    evidence.push(`Flagsmith results as of ${a.summary.asOf ?? "unknown"}: chance to win ${ctw}.`);
  }

  const caveats = [...input.guardrails.notes];
  let outcome: DualOutcome;
  let headline: string;
  let action: RecommendedAction;
  let reliabilityReason: string;

  if (status === "BREACH") {
    reliabilityReason = `Guardrail breach on ${breaching.join(", ") || subject.map((s) => s.variantKey).join(", ")}.`;
    if (winnerIsTreatment) {
      outcome = "WINNER_BUT_UNSAFE";
      headline = `"${a.winner}" wins on conversion in Flagsmith but breaches reliability guardrails. Do not ship.`;
    } else {
      outcome = "REQUIRES_INVESTIGATION";
      headline = a.state === "WINNER"
        ? `Baseline "${a.winner}" won and a treatment breached guardrails. Keep the baseline.`
        : "A treatment breached reliability guardrails while the experiment has no winner.";
    }
    action = input.flagsmithStatus === "running" ? "pause" : "investigate";
  } else if (status === "WARNING" || status === "RECOVERING") {
    outcome = "REQUIRES_INVESTIGATION";
    reliabilityReason = status === "WARNING" ? "Guardrail warning: a metric exceeded its warning threshold." : "Guardrails are recovering after a breach or warning; not yet sustained-clean.";
    headline = `${status === "WARNING" ? "Reliability warning" : "Reliability recovering"}: review the evidence before deciding.`;
    action = "investigate";
  } else if (status === "INSUFFICIENT_DATA") {
    outcome = "INSUFFICIENT_EVIDENCE";
    reliabilityReason = "Not enough attributed telemetry to judge reliability.";
    headline = "Insufficient evidence: reliability cannot be judged yet.";
    action = "collect_more_data";
  } else if (a.state === "WINNER") {
    reliabilityReason = "All guardrails are within thresholds with sufficient samples.";
    if (attributionGap) {
      outcome = "REQUIRES_INVESTIGATION";
      headline = `"${a.winner}" wins and guardrails look healthy, but too many events lack a variant assignment to be sure.`;
      action = "investigate";
    } else {
      outcome = "WINNER_AND_SAFE";
      headline = `"${a.winner}" wins in Flagsmith and is operationally healthy on the measured guardrails.`;
      action = "continue";
    }
  } else if (a.state === "INCONCLUSIVE") {
    outcome = "HEALTHY_BUT_INCONCLUSIVE";
    reliabilityReason = "All guardrails are within thresholds with sufficient samples.";
    headline = "Operationally healthy, but Flagsmith has no significant winner yet.";
    action = "continue";
  } else {
    outcome = "INSUFFICIENT_EVIDENCE";
    reliabilityReason = "All guardrails are within thresholds with sufficient samples.";
    headline = "Reliability looks healthy, but Flagsmith has no experiment results to compare against.";
    action = "collect_more_data";
  }
  caveats.push("A higher conversion rate never promotes a variant by itself; promotion remains a human decision.");

  return {
    experimentVerdict: a,
    reliabilityVerdict: { status, subjectVariants: subject.map((s) => s.variantKey), source: "variantshield-telemetry", variants: subject, reason: reliabilityReason },
    outcome, headline, recommendedAction: action, requiresHumanApproval: true, evidence, caveats,
  };
}
