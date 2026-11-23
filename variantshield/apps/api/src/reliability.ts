import type { Ctx } from "./context.ts";
import { guardrailConfigFor, type Plan } from "./plans.ts";
import { evaluate, type GuardrailReport, type Observation, type ObservationType } from "../../../packages/guardrail-engine/src/index.ts";
import { dualVerdict, type DualVerdict, type ExperimentResultSummary } from "../../../packages/verdict/src/index.ts";
import { FlagsmithError, type FlagsmithExperimentStatus } from "../../../packages/flagsmith-adapter/src/index.ts";

export type SourceFilter = "real" | "simulation";

/** Telemetry attributable to a plan. Events without a valid assignment are included with variantKey null so they are counted, never attributed. */
export function loadObservations(ctx: Ctx, plan: Plan, source: SourceFilter, sinceMs: number, untilMs: number): Observation[] {
  const ids = [plan.key, ...(plan.flagsmithExperimentId === null ? [] : [String(plan.flagsmithExperimentId)])];
  const marks = ids.map(() => "?").join(",");
  const rows = ctx.db.all(
    `SELECT type, variant_key, attribution, timestamp_ms, latency_ms, http_status FROM events
      WHERE source = ? AND timestamp_ms > ? AND timestamp_ms <= ?
        AND (experiment_id IN (${marks}) OR (experiment_id IS NULL AND feature_key = ? AND ? <> ''))`,
    source, sinceMs, untilMs, ...ids, plan.featureKey, plan.featureKey,
  );
  return rows.map((r) => ({
    variantKey: r.attribution === "valid" ? String(r.variant_key) : null,
    type: String(r.type) as ObservationType,
    timestampMs: Number(r.timestamp_ms),
    ...(r.latency_ms === null ? {} : { latencyMs: Number(r.latency_ms) }),
    ...(r.http_status === null ? {} : { httpStatus: Number(r.http_status) }),
  }));
}

export function reliabilityFor(ctx: Ctx, plan: Plan, source: SourceFilter): GuardrailReport {
  const cfg = guardrailConfigFor(ctx, plan);
  const now = ctx.now();
  const lookback = (cfg.recoveryWindows + 1) * cfg.windowMs;
  return evaluate(loadObservations(ctx, plan, source, now - lookback, now), cfg, now, plan.treatmentVariants);
}

export interface VerdictResponse {
  verdict: DualVerdict;
  provenance: { experiment: "flagsmith" | "simulation-fixture" | "unavailable"; reliability: SourceFilter };
  flagsmithStatus: FlagsmithExperimentStatus | "unknown";
  flagsmithError: { kind: string; message: string } | null;
  resultsAsOf: string | null;
}

/** Fetches Flagsmith's own status and results. Failures degrade the verdict honestly instead of guessing. */
export async function verdictFor(ctx: Ctx, plan: Plan, source: SourceFilter): Promise<VerdictResponse> {
  const report = reliabilityFor(ctx, plan, source);
  let summary: ExperimentResultSummary | null = null;
  let status: VerdictResponse["flagsmithStatus"] = "unknown";
  let experimentProvenance: VerdictResponse["provenance"]["experiment"] = "unavailable";
  let error: VerdictResponse["flagsmithError"] = null;
  let asOf: string | null = null;

  if (plan.isSimulation) {
    summary = plan.simResults;
    status = (plan.lastFlagsmithStatus as FlagsmithExperimentStatus | null) ?? "unknown";
    experimentProvenance = "simulation-fixture";
    asOf = summary?.asOf ?? null;
  } else if (plan.flagsmithExperimentId !== null && ctx.flagsmith) {
    try {
      const [exp, results] = await Promise.all([ctx.flagsmith.getExperiment(plan.flagsmithExperimentId), ctx.flagsmith.getResults(plan.flagsmithExperimentId)]);
      status = exp.status;
      summary = results?.summary ?? null;
      asOf = results?.asOf ?? null;
      experimentProvenance = "flagsmith";
    } catch (e) {
      error = e instanceof FlagsmithError ? { kind: e.kind, message: e.message } : { kind: "unknown", message: "Unexpected error talking to Flagsmith" };
    }
  } else if (plan.flagsmithExperimentId === null) {
    error = { kind: "not_linked", message: "This plan is not linked to a Flagsmith experiment." };
  } else {
    error = { kind: "config", message: "Flagsmith is not configured on this VariantShield instance." };
  }
  const verdict = dualVerdict({ experiment: summary, guardrails: report, flagsmithStatus: status, baselineVariant: plan.controlVariant });
  if (error) verdict.caveats.push(`Flagsmith data unavailable: ${error.message}`);
  return { verdict, provenance: { experiment: experimentProvenance, reliability: source }, flagsmithStatus: status, flagsmithError: error, resultsAsOf: asOf };
}
