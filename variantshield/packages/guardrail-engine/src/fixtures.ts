import type { Observation } from "./types.ts";

/** Small deterministic PRNG so fixtures and simulations are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TrafficSpec {
  variantKey: string | null;
  fromMs: number;
  toMs: number;
  sessions: number;
  paymentFailureRate?: number;
  duplicateRate?: number;
  http5xxRate?: number;
  conversionRate?: number;
  /** Median-ish latency; samples vary between 0.6x and 1.4x of this. */
  baseLatencyMs?: number;
}

/** Generates deterministic synthetic traffic. Anything built from this is SIMULATION data. */
export function generateTraffic(spec: TrafficSpec, seed: number): Observation[] {
  const rand = mulberry32(seed);
  const out: Observation[] = [];
  const span = spec.toMs - spec.fromMs;
  for (let i = 0; i < spec.sessions; i++) {
    const ts = spec.fromMs + 1 + Math.floor(((i + rand()) / spec.sessions) * (span - 1));
    const push = (type: Observation["type"], extra: Partial<Observation> = {}): void => {
      out.push({ variantKey: spec.variantKey, type, timestampMs: ts, ...extra });
    };
    push("checkout_started");
    push("http_request", { httpStatus: rand() < (spec.http5xxRate ?? 0.002) ? 503 : 200 });
    push("checkout_latency", { latencyMs: Math.round((spec.baseLatencyMs ?? 800) * (0.6 + 0.8 * rand())) });
    if (rand() < (spec.duplicateRate ?? 0.005)) push("duplicate_submit");
    if (rand() < (spec.paymentFailureRate ?? 0.02)) push("payment_failed");
    else if (rand() < (spec.conversionRate ?? 0.3)) push("checkout_completed");
  }
  return out;
}
