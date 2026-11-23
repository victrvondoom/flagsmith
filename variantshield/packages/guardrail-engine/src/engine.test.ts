import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate, mergeConfig, type Observation } from "./index.ts";
import { generateTraffic, type TrafficSpec } from "./fixtures.ts";

const W = 15 * 60_000;
const NOW = 1_800_000_000_000;
const cfg = mergeConfig({ windowMs: W });

const window = (k: number): { fromMs: number; toMs: number } => ({ fromMs: NOW - (k + 1) * W, toMs: NOW - k * W });
const traffic = (variantKey: string | null, k: number, rest: Partial<TrafficSpec>, seed: number): Observation[] =>
  generateTraffic({ variantKey, sessions: 1500, ...window(k), ...rest }, seed);
const status = (obs: Observation[], metric?: string): string => {
  const v = evaluate(obs, cfg, NOW, ["upi_first"]).variants[0]!;
  return metric ? v.metrics.find((m) => m.metric === metric)!.status : v.status;
};

describe("guardrail engine", () => {
  it("evaluate__no_traffic__reports_insufficient_data_not_healthy", () => {
    const report = evaluate([], cfg, NOW, ["upi_first"]);
    assert.equal(report.variants.length, 1);
    assert.equal(report.variants[0]!.status, "INSUFFICIENT_DATA");
    assert.ok(report.variants[0]!.metrics.every((m) => m.status === "INSUFFICIENT_DATA"));
  });

  it("evaluate__tiny_samples_with_huge_delta__never_pronounces_breach", () => {
    const obs = [
      ...traffic("control", 0, { sessions: 40, paymentFailureRate: 0 }, 1),
      ...traffic("upi_first", 0, { sessions: 40, paymentFailureRate: 0.9 }, 2),
    ];
    assert.equal(status(obs), "INSUFFICIENT_DATA");
  });

  it("evaluate__equivalent_treatment__is_healthy", () => {
    const obs = [...traffic("control", 0, {}, 3), ...traffic("upi_first", 0, {}, 4)];
    assert.equal(status(obs), "HEALTHY");
  });

  it("evaluate__rising_payment_failures__is_breach_with_reason", () => {
    const obs = [
      ...traffic("control", 0, { paymentFailureRate: 0.02 }, 5),
      ...traffic("upi_first", 0, { paymentFailureRate: 0.09 }, 6),
    ];
    assert.equal(status(obs, "payment_failure_rate"), "BREACH");
    const m = evaluate(obs, cfg, NOW, ["upi_first"]).variants[0]!.metrics.find((x) => x.metric === "payment_failure_rate")!;
    assert.ok(m.delta! > 0.03 && m.deltaLowerBound! > 0);
    assert.match(m.reason, /above baseline/);
  });

  it("evaluate__moderate_noisy_increase__is_warning_not_breach", () => {
    const obs = [
      ...traffic("control", 0, { paymentFailureRate: 0.02 }, 7),
      ...traffic("upi_first", 0, { paymentFailureRate: 0.035 }, 8),
    ];
    assert.equal(status(obs, "payment_failure_rate"), "WARNING");
  });

  it("evaluate__severe_latency_regression__is_breach", () => {
    const obs = [
      ...traffic("control", 0, { baseLatencyMs: 800 }, 9),
      ...traffic("upi_first", 0, { baseLatencyMs: 2200 }, 10),
    ];
    assert.equal(status(obs, "checkout_p95_latency_ms"), "BREACH");
    assert.equal(status(obs), "BREACH");
  });

  it("evaluate__duplicate_submission_spike__is_breach", () => {
    const obs = [
      ...traffic("control", 0, { duplicateRate: 0.005 }, 11),
      ...traffic("upi_first", 0, { duplicateRate: 0.07 }, 12),
    ];
    assert.equal(status(obs, "duplicate_submission_rate"), "BREACH");
  });

  it("evaluate__5xx_increase__is_breach", () => {
    const obs = [
      ...traffic("control", 0, { http5xxRate: 0.002 }, 13),
      ...traffic("upi_first", 0, { http5xxRate: 0.04 }, 14),
    ];
    assert.equal(status(obs, "http_5xx_rate"), "BREACH");
  });

  it("evaluate__clean_window_right_after_breach__is_recovering", () => {
    const obs = [
      ...traffic("control", 0, {}, 15), ...traffic("control", 1, {}, 16),
      ...traffic("upi_first", 0, {}, 17),
      ...traffic("upi_first", 1, { paymentFailureRate: 0.1 }, 18),
    ];
    assert.equal(status(obs, "payment_failure_rate"), "RECOVERING");
    assert.equal(status(obs), "RECOVERING");
  });

  it("evaluate__enough_clean_windows_after_breach__returns_to_healthy", () => {
    const obs = [0, 1, 2].flatMap((k) => traffic("control", k, {}, 20 + k));
    obs.push(...traffic("upi_first", 0, {}, 30), ...traffic("upi_first", 1, {}, 31), ...traffic("upi_first", 2, { paymentFailureRate: 0.1 }, 32));
    assert.equal(status(obs, "payment_failure_rate"), "HEALTHY");
  });

  it("evaluate__still_breaching_after_earlier_breach__stays_breach", () => {
    const obs = [0, 1].flatMap((k) => [
      ...traffic("control", k, {}, 40 + k),
      ...traffic("upi_first", k, { paymentFailureRate: 0.1 }, 50 + k),
    ]);
    assert.equal(status(obs, "payment_failure_rate"), "BREACH");
  });

  it("evaluate__missing_variant_assignment__is_excluded_and_flagged", () => {
    const obs = [
      ...traffic("control", 0, {}, 60),
      ...traffic("upi_first", 0, {}, 61),
      ...traffic(null, 0, { sessions: 400, paymentFailureRate: 0.9 }, 62),
    ];
    const report = evaluate(obs, cfg, NOW, ["upi_first"]);
    assert.equal(report.variants[0]!.status, "HEALTHY", "unattributed failures must not leak into any variant");
    assert.equal(report.variants[0]!.dataQuality.flagged, true);
    assert.ok(report.variants[0]!.dataQuality.unattributed > 0);
    assert.ok(report.notes.some((n) => /no valid variant assignment/.test(n)));
  });

  it("evaluate__missing_baseline_traffic__is_insufficient_data", () => {
    const obs = traffic("upi_first", 0, { paymentFailureRate: 0.5 }, 70);
    assert.equal(status(obs), "INSUFFICIENT_DATA");
  });

  it("mergeConfig__inverted_thresholds__throws", () => {
    assert.throws(() => mergeConfig({ rules: { payment_failure_rate: { warnDelta: 0.1, breachDelta: 0.01 } } }), RangeError);
  });

  it("evaluate__same_input_twice__is_deterministic", () => {
    const obs = [...traffic("control", 0, {}, 80), ...traffic("upi_first", 0, { paymentFailureRate: 0.08 }, 81)];
    assert.deepEqual(evaluate(obs, cfg, NOW), evaluate(obs, cfg, NOW));
  });
});

describe("timeline", () => {
  it("timeline__regression_starting_in_the_last_bucket__shows_up_only_there_and_in_the_threshold_lines", async () => {
    const { timeline } = await import("./index.ts");
    const B = 5 * 60_000;
    const obs = [
      ...generateTraffic({ variantKey: "control", sessions: 1200, fromMs: NOW - 12 * B, toMs: NOW }, 91),
      ...generateTraffic({ variantKey: "upi_first", sessions: 1100, fromMs: NOW - 12 * B, toMs: NOW - B, paymentFailureRate: 0.02 }, 92),
      ...generateTraffic({ variantKey: "upi_first", sessions: 200, fromMs: NOW - B, toMs: NOW, paymentFailureRate: 0.3 }, 93),
    ];
    const t = timeline(obs, mergeConfig({ windowMs: 15 * 60_000 }), NOW, { buckets: 12, bucketMs: B });
    assert.equal(t.points.length, 12);
    assert.deepEqual(t.variants, ["control", "upi_first"]);
    const last = t.points[11]!.variants.upi_first!, earlier = t.points[3]!.variants.upi_first!;
    assert.ok(last.paymentFailureRate! > 0.2 && earlier.paymentFailureRate! < 0.08);
    const th = t.thresholds.payment_failure_rate;
    assert.ok(th.breach! > th.warn! && th.warn! > th.baseline!);
    assert.ok(t.thresholds.checkout_p95_latency_ms.breach! > t.thresholds.checkout_p95_latency_ms.baseline!);
  });

  it("timeline__unattributed_traffic__is_excluded_not_assigned", async () => {
    const { timeline } = await import("./index.ts");
    const t = timeline(generateTraffic({ variantKey: null, sessions: 300, fromMs: NOW - 900_000, toMs: NOW }, 94), mergeConfig({ windowMs: 15 * 60_000 }), NOW);
    assert.deepEqual(t.variants, []);
  });

  it("timeline__empty_buckets__have_null_rates_not_zero", async () => {
    const { timeline } = await import("./index.ts");
    const t = timeline(generateTraffic({ variantKey: "control", sessions: 50, fromMs: NOW - 60_000, toMs: NOW }, 95), mergeConfig({ windowMs: 15 * 60_000 }), NOW, { buckets: 6, bucketMs: 300_000 });
    assert.equal(t.points[0]!.variants.control!.paymentFailureRate, null);
    assert.ok(t.points[5]!.variants.control!.paymentFailureRate !== null);
  });
});
