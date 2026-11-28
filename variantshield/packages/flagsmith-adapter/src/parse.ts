import { FlagsmithError } from "./errors.ts";
import { EXPERIMENT_STATUSES, type ExposureSnapshot, type FlagsmithExperiment, type FlagsmithExperimentStatus, type ResultsSnapshot } from "./types.ts";
import type { ExperimentResultSummary } from "../../verdict/src/index.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const contract = (what: string, detail?: unknown): FlagsmithError =>
  new FlagsmithError("contract", `Unexpected Flagsmith response: ${what}`, { detail });
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Flagsmith's own sample floors for showing inference (experimentation/constants.py). */
export const MIN_IDENTITIES_PER_VARIANT = 50;
export const MIN_CONVERSIONS_PER_VARIANT = 5;
export const CONTROL_VARIANT_KEY = "control";

export function parseExperiment(raw: unknown): FlagsmithExperiment {
  if (!isObj(raw)) throw contract("experiment is not an object");
  const id = numOrNull(raw.id);
  const status = raw.status;
  if (id === null) throw contract("experiment.id missing", raw);
  if (typeof status !== "string" || !(EXPERIMENT_STATUSES as readonly string[]).includes(status)) {
    throw contract(`experiment.status "${String(status)}" is not one of ${EXPERIMENT_STATUSES.join(", ")}`, raw);
  }
  const feature = isObj(raw.feature) ? raw.feature : null;
  const options = Array.isArray(feature?.multivariate_options) ? feature.multivariate_options : [];
  return {
    id,
    name: strOrNull(raw.name) ?? `experiment-${id}`,
    hypothesis: strOrNull(raw.hypothesis) ?? "",
    status: status as FlagsmithExperimentStatus,
    featureName: strOrNull(feature?.name),
    featureId: numOrNull(feature?.id),
    variantOptions: options
      .map((o) => (isObj(o) ? (strOrNull(o.string_value) ?? strOrNull(o.value) ?? strOrNull(o.name)) : null))
      .filter((v): v is string => v !== null),
    createdAt: strOrNull(raw.created_at),
    startedAt: strOrNull(raw.started_at),
    endedAt: strOrNull(raw.ended_at),
    updatedAt: strOrNull(raw.updated_at),
  };
}

export function parsePage(raw: unknown): { results: unknown[]; next: string | null } {
  if (Array.isArray(raw)) return { results: raw, next: null };
  if (!isObj(raw) || !Array.isArray(raw.results)) throw contract("list response has no results array", raw);
  return { results: raw.results, next: strOrNull(raw.next) };
}

/** `GET .../exposures/` returns `{ exposures: { as_of, is_final, payload } | null }`. */
export function parseExposures(raw: unknown): ExposureSnapshot | null {
  if (!isObj(raw) || !("exposures" in raw)) throw contract("exposures envelope missing", raw);
  const e = raw.exposures;
  if (e === null) return null;
  if (!isObj(e)) throw contract("exposures is not an object", raw);
  const payload = isObj(e.payload) ? e.payload : null;
  const points = payload && isObj(payload.timeseries) && Array.isArray(payload.timeseries.points) ? payload.timeseries.points : [];
  const totals = new Map<string, number>();
  for (const p of points) {
    if (!isObj(p) || !isObj(p.new_identities)) continue;
    for (const [variant, n] of Object.entries(p.new_identities)) {
      if (typeof n === "number") totals.set(variant, (totals.get(variant) ?? 0) + n);
    }
  }
  return {
    asOf: strOrNull(e.as_of),
    isFinal: e.is_final === true,
    excludedIdentities: numOrNull(payload?.excluded_identities) ?? 0,
    variants: [...totals.entries()].map(([variant, identities]) => ({ variant, identities })).sort((a, b) => a.variant.localeCompare(b.variant)),
  };
}

/**
 * `GET .../results/` returns `{ results: { as_of, is_final, last_error_at, payload } | null }` where payload is
 * Flagsmith's ResultsSummary: per-metric `variants {n,sum,sum_squares}` and `inference {lift,ci_low,ci_high,chance_to_win}`.
 * We only read those numbers; a "winner" is a variant whose Flagsmith-reported chance_to_win clears the configured
 * probability with a credible interval above zero, on a metric with Flagsmith's own sample floors met.
 */
export function parseResults(raw: unknown, opts: { winProbability: number; primaryMetricId?: number }): ResultsSnapshot | null {
  if (!isObj(raw) || !("results" in raw)) throw contract("results envelope missing", raw);
  const r = raw.results;
  if (r === null) return null;
  if (!isObj(r)) throw contract("results is not an object", raw);
  const payload = isObj(r.payload) ? r.payload : null;
  const metrics = payload && Array.isArray(payload.metrics) ? payload.metrics.filter(isObj) : [];
  const primary = (opts.primaryMetricId === undefined ? metrics[0] : metrics.find((m) => m.metric_id === opts.primaryMetricId)) ?? null;

  const summary: ExperimentResultSummary = {
    asOf: strOrNull(r.as_of), isFinal: r.is_final === true, winner: null, significant: false, chanceToWin: {},
    lift: null, recommendation: null, sampleSizeWarning: null, variants: [],
  };
  if (!primary) {
    summary.sampleSizeWarning = "Flagsmith has not produced a metric result yet.";
    return { asOf: summary.asOf, isFinal: summary.isFinal, lastErrorAt: strOrNull(r.last_error_at), summary };
  }

  const stats = isObj(primary.variants) ? primary.variants : {};
  for (const [variant, s] of Object.entries(stats)) {
    if (!isObj(s)) continue;
    const n = numOrNull(s.n) ?? 0;
    const sum = numOrNull(s.sum) ?? 0;
    summary.variants.push({ variant, evaluations: n, conversions: sum, conversionRate: n > 0 ? sum / n : 0 });
  }
  summary.variants.sort((a, b) => a.variant.localeCompare(b.variant));

  const floorsMet = summary.variants.length >= 2 && summary.variants.every((v) => v.evaluations >= MIN_IDENTITIES_PER_VARIANT && v.conversions >= MIN_CONVERSIONS_PER_VARIANT);
  if (!floorsMet) {
    summary.sampleSizeWarning = `Below Flagsmith's floors of ${MIN_IDENTITIES_PER_VARIANT} identities and ${MIN_CONVERSIONS_PER_VARIANT} conversions per variant.`;
  }

  const inference = isObj(primary.inference) ? primary.inference : {};
  let best: { variant: string; p: number; lift: number } | null = null;
  for (const [variant, inf] of Object.entries(inference)) {
    if (!isObj(inf)) continue;
    const p = numOrNull(inf.chance_to_win);
    const lift = numOrNull(inf.lift);
    const lo = numOrNull(inf.ci_low);
    if (p === null || lift === null) continue;
    summary.chanceToWin[variant] = p;
    if (floorsMet && p >= opts.winProbability && lo !== null && lo > 0 && (best === null || p > best.p)) best = { variant, p, lift };
  }
  if (best) {
    summary.winner = best.variant;
    summary.significant = true;
    summary.lift = `${best.lift >= 0 ? "+" : ""}${(best.lift * 100).toFixed(1)}%`;
    summary.recommendation = `Flagsmith reports ${(best.p * 100).toFixed(1)}% chance that ${best.variant} beats ${CONTROL_VARIANT_KEY}.`;
  }
  return { asOf: summary.asOf, isFinal: summary.isFinal, lastErrorAt: strOrNull(r.last_error_at), summary };
}
