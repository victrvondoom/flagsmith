import type { GuardrailConfig } from "./types.ts";

export const DEFAULT_CONFIG: GuardrailConfig = {
  baselineVariant: "control",
  windowMs: 15 * 60 * 1000,
  recoveryWindows: 2,
  z: 1.96,
  maxUnattributedShare: 0.05,
  rules: {
    payment_failure_rate: { warnDelta: 0.01, breachDelta: 0.03, minDenominator: 200 },
    duplicate_submission_rate: { warnDelta: 0.01, breachDelta: 0.03, minDenominator: 200 },
    http_5xx_rate: { warnDelta: 0.005, breachDelta: 0.02, minDenominator: 500 },
    checkout_p95_latency_ms: { warnRatio: 1.25, breachRatio: 1.6, minSamples: 100 },
  },
};

export function mergeConfig(overrides: DeepPartial<GuardrailConfig> = {}): GuardrailConfig {
  const base = DEFAULT_CONFIG;
  const merged: GuardrailConfig = {
    ...base,
    ...stripUndefined(overrides),
    rules: {
      payment_failure_rate: { ...base.rules.payment_failure_rate, ...overrides.rules?.payment_failure_rate },
      duplicate_submission_rate: { ...base.rules.duplicate_submission_rate, ...overrides.rules?.duplicate_submission_rate },
      http_5xx_rate: { ...base.rules.http_5xx_rate, ...overrides.rules?.http_5xx_rate },
      checkout_p95_latency_ms: { ...base.rules.checkout_p95_latency_ms, ...overrides.rules?.checkout_p95_latency_ms },
    },
  };
  validateConfig(merged);
  return merged;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && k !== "rules")) as T;
}

export function validateConfig(c: GuardrailConfig): void {
  const fail = (m: string): never => {
    throw new RangeError(`Invalid guardrail config: ${m}`);
  };
  if (!c.baselineVariant) fail("baselineVariant is required");
  if (!(c.windowMs >= 1000)) fail("windowMs must be at least 1000");
  if (!Number.isInteger(c.recoveryWindows) || c.recoveryWindows < 1) fail("recoveryWindows must be an integer >= 1");
  if (!(c.z > 0)) fail("z must be positive");
  for (const key of ["payment_failure_rate", "duplicate_submission_rate", "http_5xx_rate"] as const) {
    const r = c.rules[key];
    if (!(r.warnDelta > 0 && r.breachDelta >= r.warnDelta)) fail(`${key}: need 0 < warnDelta <= breachDelta`);
    if (!(r.minDenominator >= 1)) fail(`${key}: minDenominator must be >= 1`);
  }
  const l = c.rules.checkout_p95_latency_ms;
  if (!(l.warnRatio > 1 && l.breachRatio >= l.warnRatio)) fail("latency: need 1 < warnRatio <= breachRatio");
  if (!(l.minSamples >= 1)) fail("latency: minSamples must be >= 1");
}
