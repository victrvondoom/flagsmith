export type GuardrailStatus = "INSUFFICIENT_DATA" | "HEALTHY" | "WARNING" | "BREACH" | "RECOVERING";

export type MetricId =
  | "payment_failure_rate"
  | "duplicate_submission_rate"
  | "http_5xx_rate"
  | "checkout_p95_latency_ms";

export type ObservationType =
  | "checkout_started"
  | "checkout_completed"
  | "payment_failed"
  | "duplicate_submit"
  | "checkout_latency"
  | "http_request";

/** One attributed operational observation. `variantKey: null` means no valid assignment. */
export interface Observation {
  variantKey: string | null;
  type: ObservationType;
  timestampMs: number;
  latencyMs?: number;
  httpStatus?: number;
}

export interface RateRule {
  /** Absolute increase over baseline (0.02 = 2 percentage points) that raises a warning. */
  warnDelta: number;
  /** Absolute increase over baseline that is a breach, if the interval excludes zero. */
  breachDelta: number;
  /** Minimum denominator per variant before any verdict is given. */
  minDenominator: number;
}

export interface LatencyRule {
  /** p95 ratio (treatment / baseline) that raises a warning. */
  warnRatio: number;
  /** p95 ratio that is a breach. */
  breachRatio: number;
  /** Minimum latency samples per variant before any verdict is given. */
  minSamples: number;
}

export interface GuardrailConfig {
  /** Variant every treatment is compared against. */
  baselineVariant: string;
  /** Observation window length in milliseconds. */
  windowMs: number;
  /** Consecutive clean windows needed before a past breach or warning stops being RECOVERING. */
  recoveryWindows: number;
  /** z-score for the confidence interval on rate differences (1.96 = 95%). */
  z: number;
  /** Share of unattributed observations above which a data-quality flag is raised. */
  maxUnattributedShare: number;
  rules: {
    payment_failure_rate: RateRule;
    duplicate_submission_rate: RateRule;
    http_5xx_rate: RateRule;
    checkout_p95_latency_ms: LatencyRule;
  };
}

export interface Side {
  value: number | null;
  sampleSize: number;
}

export interface MetricResult {
  metric: MetricId;
  status: GuardrailStatus;
  treatment: Side;
  baseline: Side;
  /** Absolute difference for rate metrics. */
  delta: number | null;
  /** Lower bound of the confidence interval of the difference (rate metrics). */
  deltaLowerBound: number | null;
  /** Treatment / baseline ratio (latency metric). */
  ratio: number | null;
  thresholds: RateRule | LatencyRule;
  windowFromMs: number;
  windowToMs: number;
  reason: string;
}

export interface DataQuality {
  total: number;
  unattributed: number;
  unattributedShare: number;
  flagged: boolean;
}

export interface VariantReport {
  variantKey: string;
  status: GuardrailStatus;
  metrics: MetricResult[];
  dataQuality: DataQuality;
}

export interface GuardrailReport {
  baselineVariant: string;
  evaluatedAtMs: number;
  windowMs: number;
  variants: VariantReport[];
  notes: string[];
}
