import type {
  DataQuality,
  GuardrailConfig,
  GuardrailReport,
  GuardrailStatus,
  MetricId,
  MetricResult,
  Observation,
  RateRule,
  VariantReport,
} from "./types.ts";
import { differenceLowerBound, percentile } from "./stats.ts";

const SEVERITY: Record<GuardrailStatus, number> = {
  BREACH: 4,
  WARNING: 3,
  RECOVERING: 2,
  INSUFFICIENT_DATA: 1,
  HEALTHY: 0,
};

/** Worst status wins; INSUFFICIENT_DATA outranks HEALTHY so we never claim health without data. */
export function worstStatus(statuses: readonly GuardrailStatus[]): GuardrailStatus {
  if (statuses.length === 0) return "INSUFFICIENT_DATA";
  return statuses.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
}

interface Counts {
  started: number;
  paymentFailed: number;
  duplicates: number;
  http: number;
  http5xx: number;
  latencies: number[];
}

function emptyCounts(): Counts {
  return { started: 0, paymentFailed: 0, duplicates: 0, http: 0, http5xx: 0, latencies: [] };
}

function tally(observations: readonly Observation[], variant: string, fromMs: number, toMs: number): Counts {
  const c = emptyCounts();
  for (const o of observations) {
    if (o.variantKey !== variant || o.timestampMs <= fromMs || o.timestampMs > toMs) continue;
    switch (o.type) {
      case "checkout_started": c.started++; break;
      case "payment_failed": c.paymentFailed++; break;
      case "duplicate_submit": c.duplicates++; break;
      case "http_request":
        c.http++;
        if ((o.httpStatus ?? 0) >= 500) c.http5xx++;
        break;
      case "checkout_latency":
        if (typeof o.latencyMs === "number" && Number.isFinite(o.latencyMs) && o.latencyMs >= 0) c.latencies.push(o.latencyMs);
        break;
      default: break;
    }
  }
  return c;
}

function rateInputs(metric: MetricId, c: Counts): { numerator: number; denominator: number } {
  switch (metric) {
    case "payment_failure_rate": return { numerator: c.paymentFailed, denominator: c.started };
    case "duplicate_submission_rate": return { numerator: c.duplicates, denominator: c.started };
    case "http_5xx_rate": return { numerator: c.http5xx, denominator: c.http };
    default: throw new Error(`not a rate metric: ${metric}`);
  }
}

type RateMetricId = Exclude<MetricId, "checkout_p95_latency_ms">;
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

function evaluateRate(metric: RateMetricId, t: Counts, b: Counts, cfg: GuardrailConfig, fromMs: number, toMs: number): MetricResult {
  const rule: RateRule = cfg.rules[metric];
  const ti = rateInputs(metric, t);
  const bi = rateInputs(metric, b);
  const base = {
    metric,
    treatment: { value: ti.denominator ? ti.numerator / ti.denominator : null, sampleSize: ti.denominator },
    baseline: { value: bi.denominator ? bi.numerator / bi.denominator : null, sampleSize: bi.denominator },
    ratio: null,
    thresholds: rule,
    windowFromMs: fromMs,
    windowToMs: toMs,
  };
  if (ti.denominator < rule.minDenominator || bi.denominator < rule.minDenominator) {
    return {
      ...base, status: "INSUFFICIENT_DATA", delta: null, deltaLowerBound: null,
      reason: `Need at least ${rule.minDenominator} per variant (treatment ${ti.denominator}, baseline ${bi.denominator}).`,
    };
  }
  const delta = ti.numerator / ti.denominator - bi.numerator / bi.denominator;
  const lower = differenceLowerBound(ti.numerator, ti.denominator, bi.numerator, bi.denominator, cfg.z);
  let status: GuardrailStatus = "HEALTHY";
  let reason = `Difference ${pct(delta)} is below the warning threshold ${pct(rule.warnDelta)}.`;
  if (delta >= rule.breachDelta && lower > 0) {
    status = "BREACH";
    reason = `Treatment is ${pct(delta)} above baseline (>= ${pct(rule.breachDelta)}) and the interval excludes zero (lower bound ${pct(lower)}).`;
  } else if (delta >= rule.warnDelta) {
    status = "WARNING";
    reason = lower > 0
      ? `Treatment is ${pct(delta)} above baseline (>= ${pct(rule.warnDelta)}).`
      : `Treatment is ${pct(delta)} above baseline but the interval includes zero; could be noise.`;
  }
  return { ...base, status, delta, deltaLowerBound: lower, reason };
}

function evaluateLatency(t: Counts, b: Counts, cfg: GuardrailConfig, fromMs: number, toMs: number): MetricResult {
  const rule = cfg.rules.checkout_p95_latency_ms;
  const tp = percentile(t.latencies, 0.95);
  const bp = percentile(b.latencies, 0.95);
  const base = {
    metric: "checkout_p95_latency_ms" as const,
    treatment: { value: tp, sampleSize: t.latencies.length },
    baseline: { value: bp, sampleSize: b.latencies.length },
    delta: null,
    deltaLowerBound: null,
    thresholds: rule,
    windowFromMs: fromMs,
    windowToMs: toMs,
  };
  if (tp === null || bp === null || t.latencies.length < rule.minSamples || b.latencies.length < rule.minSamples || bp <= 0) {
    return {
      ...base, status: "INSUFFICIENT_DATA", ratio: null,
      reason: `Need at least ${rule.minSamples} latency samples per variant (treatment ${t.latencies.length}, baseline ${b.latencies.length}).`,
    };
  }
  const ratio = tp / bp;
  let status: GuardrailStatus = "HEALTHY";
  let reason = `p95 ${Math.round(tp)}ms vs baseline ${Math.round(bp)}ms (x${ratio.toFixed(2)}).`;
  if (ratio >= rule.breachRatio) {
    status = "BREACH";
    reason = `p95 ${Math.round(tp)}ms is x${ratio.toFixed(2)} the baseline ${Math.round(bp)}ms (>= x${rule.breachRatio}).`;
  } else if (ratio >= rule.warnRatio) {
    status = "WARNING";
    reason = `p95 ${Math.round(tp)}ms is x${ratio.toFixed(2)} the baseline ${Math.round(bp)}ms (>= x${rule.warnRatio}).`;
  }
  return { ...base, status, ratio, reason };
}

function evaluateWindow(
  metric: MetricId, observations: readonly Observation[], variant: string, cfg: GuardrailConfig, k: number, nowMs: number,
): MetricResult {
  const toMs = nowMs - k * cfg.windowMs;
  const fromMs = toMs - cfg.windowMs;
  const t = tally(observations, variant, fromMs, toMs);
  const b = tally(observations, cfg.baselineVariant, fromMs, toMs);
  return metric === "checkout_p95_latency_ms"
    ? evaluateLatency(t, b, cfg, fromMs, toMs)
    : evaluateRate(metric, t, b, cfg, fromMs, toMs);
}

/** Applies the recovery rule: a clean window after a breach or warning is RECOVERING until enough clean windows pass. */
function metricWithHistory(
  metric: MetricId, observations: readonly Observation[], variant: string, cfg: GuardrailConfig, nowMs: number,
): MetricResult {
  const current = evaluateWindow(metric, observations, variant, cfg, 0, nowMs);
  if (current.status !== "HEALTHY") return current;
  const history: GuardrailStatus[] = [];
  for (let k = 1; k <= cfg.recoveryWindows; k++) history.push(evaluateWindow(metric, observations, variant, cfg, k, nowMs).status);
  const wasUnhealthy = history.some((s) => s === "BREACH" || s === "WARNING");
  let clean = 1;
  for (const s of history) {
    if (s === "HEALTHY") clean++;
    else break;
  }
  if (wasUnhealthy && clean < cfg.recoveryWindows) {
    return { ...current, status: "RECOVERING", reason: `Back under thresholds, but ${clean} of ${cfg.recoveryWindows} clean windows so far after a recent breach or warning. ${current.reason}` };
  }
  return current;
}

function dataQuality(observations: readonly Observation[], cfg: GuardrailConfig, nowMs: number): DataQuality {
  const fromMs = nowMs - cfg.windowMs;
  const inWindow = observations.filter((o) => o.timestampMs > fromMs && o.timestampMs <= nowMs);
  const total = inWindow.length;
  const unattributed = inWindow.filter((o) => o.variantKey === null).length;
  const share = total ? unattributed / total : 0;
  return { total, unattributed, unattributedShare: share, flagged: share > cfg.maxUnattributedShare };
}

/** Evaluates every treatment variant against the configured baseline. Pure and deterministic. */
export function evaluate(
  observations: readonly Observation[],
  cfg: GuardrailConfig,
  nowMs: number,
  /** Treatments to report even when they have no traffic yet. */
  knownTreatments: readonly string[] = [],
): GuardrailReport {
  const variantKeys = [
    ...new Set([...knownTreatments, ...observations.map((o) => o.variantKey).filter((v): v is string => v !== null)]),
  ]
    .filter((v) => v !== cfg.baselineVariant)
    .sort();
  const notes: string[] = [
    "Guardrail statuses describe association between a variant and operational signals; they do not establish causation.",
  ];
  const quality = dataQuality(observations, cfg, nowMs);
  if (quality.flagged) {
    notes.push(`${quality.unattributed} of ${quality.total} observations in the current window have no valid variant assignment and are excluded.`);
  }
  if (!observations.some((o) => o.variantKey === cfg.baselineVariant)) {
    notes.push(`No observations for baseline variant "${cfg.baselineVariant}"; every metric is INSUFFICIENT_DATA.`);
  }
  const variants: VariantReport[] = variantKeys.map((variantKey) => {
    const metrics = (["payment_failure_rate", "duplicate_submission_rate", "http_5xx_rate", "checkout_p95_latency_ms"] as const)
      .map((m) => metricWithHistory(m, observations, variantKey, cfg, nowMs));
    return { variantKey, status: worstStatus(metrics.map((m) => m.status)), metrics, dataQuality: quality };
  });
  return { baselineVariant: cfg.baselineVariant, evaluatedAtMs: nowMs, windowMs: cfg.windowMs, variants, notes };
}
