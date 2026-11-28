import { percentile } from "./stats.ts";
import type { GuardrailConfig, Observation } from "./types.ts";

export interface TimelineVariantPoint {
  sessions: number;
  completed: number;
  conversionRate: number | null;
  paymentFailureRate: number | null;
  duplicateRate: number | null;
  http5xxRate: number | null;
  p95LatencyMs: number | null;
  latencySamples: number;
}

export interface Timeline {
  bucketMs: number;
  points: { startMs: number; endMs: number; variants: Record<string, TimelineVariantPoint> }[];
  variants: string[];
  /** Whole-range baseline rates plus the guardrail lines derived from the configured thresholds. */
  thresholds: Record<"payment_failure_rate" | "duplicate_submission_rate" | "http_5xx_rate" | "checkout_p95_latency_ms", { baseline: number | null; warn: number | null; breach: number | null }>;
}

/** Fixed-width buckets ending at nowMs, per variant. Unattributed observations (variantKey null) are excluded, never assigned. */
export function timeline(observations: readonly Observation[], cfg: GuardrailConfig, nowMs: number, opts: { buckets?: number; bucketMs?: number } = {}): Timeline {
  const buckets = Math.max(2, Math.min(48, opts.buckets ?? 12));
  const bucketMs = opts.bucketMs ?? Math.max(60_000, Math.round(cfg.windowMs / 3));
  const start = nowMs - buckets * bucketMs;
  const variants = [...new Set(observations.filter((o) => o.variantKey !== null && o.timestampMs > start && o.timestampMs <= nowMs).map((o) => o.variantKey!))].sort((a, b) => (a === cfg.baselineVariant ? -1 : b === cfg.baselineVariant ? 1 : a.localeCompare(b)));
  const points: Timeline["points"] = [];
  const totals: Record<string, { started: number; failed: number; dup: number; http: number; err: number; lat: number[] }> = {};
  for (let i = 0; i < buckets; i++) {
    const from = start + i * bucketMs, to = from + bucketMs;
    const row: Record<string, TimelineVariantPoint> = {};
    for (const v of variants) {
      let started = 0, completed = 0, failed = 0, dup = 0, http = 0, err = 0;
      const lat: number[] = [];
      for (const o of observations) {
        if (o.variantKey !== v || o.timestampMs <= from || o.timestampMs > to) continue;
        if (o.type === "checkout_started") started++;
        else if (o.type === "checkout_completed") completed++;
        else if (o.type === "payment_failed") failed++;
        else if (o.type === "duplicate_submit") dup++;
        else if (o.type === "http_request") { http++; if ((o.httpStatus ?? 0) >= 500) err++; }
        else if (o.type === "checkout_latency" && typeof o.latencyMs === "number") lat.push(o.latencyMs);
      }
      const t = (totals[v] ??= { started: 0, failed: 0, dup: 0, http: 0, err: 0, lat: [] });
      t.started += started; t.failed += failed; t.dup += dup; t.http += http; t.err += err; t.lat.push(...lat);
      row[v] = { sessions: started, completed, conversionRate: started ? completed / started : null, paymentFailureRate: started ? failed / started : null, duplicateRate: started ? dup / started : null, http5xxRate: http ? err / http : null, p95LatencyMs: percentile(lat, 0.95), latencySamples: lat.length };
    }
    points.push({ startMs: from, endMs: to, variants: row });
  }
  const b = totals[cfg.baselineVariant];
  const base = {
    payment_failure_rate: b && b.started ? b.failed / b.started : null, duplicate_submission_rate: b && b.started ? b.dup / b.started : null,
    http_5xx_rate: b && b.http ? b.err / b.http : null, checkout_p95_latency_ms: b ? percentile(b.lat, 0.95) : null,
  };
  const rate = (k: "payment_failure_rate" | "duplicate_submission_rate" | "http_5xx_rate"): Timeline["thresholds"][typeof k] => ({ baseline: base[k], warn: base[k] === null ? null : base[k]! + cfg.rules[k].warnDelta, breach: base[k] === null ? null : base[k]! + cfg.rules[k].breachDelta });
  const lr = cfg.rules.checkout_p95_latency_ms;
  return {
    bucketMs, points, variants,
    thresholds: { payment_failure_rate: rate("payment_failure_rate"), duplicate_submission_rate: rate("duplicate_submission_rate"), http_5xx_rate: rate("http_5xx_rate"),
      checkout_p95_latency_ms: { baseline: base.checkout_p95_latency_ms, warn: base.checkout_p95_latency_ms === null ? null : base.checkout_p95_latency_ms * lr.warnRatio, breach: base.checkout_p95_latency_ms === null ? null : base.checkout_p95_latency_ms * lr.breachRatio } },
  };
}
