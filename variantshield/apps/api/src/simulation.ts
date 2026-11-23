import type { Ctx } from "./context.ts";
import { createPlan, getPlan, type Plan } from "./plans.ts";
import { generateTraffic, type TrafficSpec } from "../../../packages/guardrail-engine/src/fixtures.ts";
import type { Observation } from "../../../packages/guardrail-engine/src/index.ts";
import { hashEvent, type TelemetryEvent } from "../../../packages/telemetry/src/index.ts";
import type { ExperimentResultSummary } from "../../../packages/verdict/src/index.ts";
import { HttpError } from "./http.ts";

/**
 * SIMULATION MODE. Everything produced here is deterministic synthetic data stored with source = "simulation",
 * attached to plans flagged is_simulation. It is never mixed into real observations and never calls Flagsmith.
 */
export interface Scenario {
  id: "safe-winner" | "dangerous-winner";
  title: string;
  description: string;
  traffic: Record<string, Partial<TrafficSpec>>;
  chanceToWin: number;
  lift: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "safe-winner",
    title: "Safe winner",
    description: "upi_first converts better and stays inside every reliability guardrail.",
    traffic: { control: {}, upi_first: { conversionRate: 0.36 }, one_tap: { conversionRate: 0.31 } },
    chanceToWin: 0.99, lift: "+20.0%",
  },
  {
    id: "dangerous-winner",
    title: "Dangerous winner",
    description: "upi_first wins on conversion but payment failures, duplicate submissions and p95 latency regress.",
    traffic: { control: {}, upi_first: { conversionRate: 0.36, paymentFailureRate: 0.09, duplicateRate: 0.06, baseLatencyMs: 2100, http5xxRate: 0.03 }, one_tap: { conversionRate: 0.31 } },
    chanceToWin: 0.99, lift: "+20.0%",
  },
];

const SESSIONS_PER_WINDOW = 1500;

function toEvents(obs: Observation[], experimentKey: string, scenario: string, offset: number): TelemetryEvent[] {
  let session = -1;
  let lastTs = -1;
  let lastVariant: string | null = null;
  return obs.map((o, i) => {
    if (o.type === "checkout_started" || o.timestampMs !== lastTs || o.variantKey !== lastVariant) session++;
    lastTs = o.timestampMs; lastVariant = o.variantKey;
    const idNo = offset + session;
    return {
      eventId: `sim-${scenario}-${offset + i}`, type: o.type, experimentId: experimentKey, featureKey: "checkout_flow", variantKey: o.variantKey,
      identityId: `sim-user-${idNo}`, timestampMs: o.timestampMs, requestId: `sim-req-${offset + i}`, operation: `checkout.${o.type}`,
      outcome: o.type === "payment_failed" ? "failure" : o.type === "duplicate_submit" ? "rejected" : o.type === "http_request" && (o.httpStatus ?? 0) >= 500 ? "failure" : "success",
      latencyMs: o.latencyMs ?? null, errorCategory: o.type === "payment_failed" ? "payment_declined" : o.type === "http_request" && (o.httpStatus ?? 0) >= 500 ? "server_error" : null,
      httpStatus: o.httpStatus ?? null, source: "simulation" as const, attribution: "valid" as const,
    };
  });
}

export function runScenario(ctx: Ctx, id: string): { plan: Plan; events: number } {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new HttpError(404, "scenario_not_found", `Unknown scenario "${id}". Available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  const key = `sim-${scenario.id}`;
  const now = ctx.now();
  const W = ctx.cfg.guardrails.windowMs;
  const fixture: ExperimentResultSummary = {
    asOf: new Date(now).toISOString(), isFinal: false, winner: "upi_first", significant: true, chanceToWin: { upi_first: scenario.chanceToWin, one_tap: 0.7 },
    lift: scenario.lift, recommendation: "SIMULATED Flagsmith result fixture", sampleSizeWarning: null,
    variants: ["control", "upi_first", "one_tap"].map((variant, i) => ({ variant, evaluations: SESSIONS_PER_WINDOW, conversions: Math.round(SESSIONS_PER_WINDOW * [0.3, 0.36, 0.31][i]!), conversionRate: [0.3, 0.36, 0.31][i]! })),
  };

  // Replace any previous run of this scenario so the simulation is repeatable.
  ctx.db.tx(() => {
    ctx.db.run("DELETE FROM events WHERE source = 'simulation' AND experiment_id = ?", key);
    const existing = ctx.db.get("SELECT id FROM plans WHERE key = ?", key);
    if (existing) ctx.db.run("DELETE FROM plans WHERE id = ?", Number(existing.id));
  });
  const plan = createPlan(ctx, {
    key, title: `[SIMULATION] Checkout flow: ${scenario.title}`, hypothesis: scenario.description, controlVariant: "control", treatmentVariants: ["upi_first", "one_tap"],
    featureKey: "checkout_flow", primaryMetric: "checkout_completed", owner: "simulation",
    businessProblem: "Synthetic scenario: shows how VariantShield separates a conversion winner from an operationally safe variant.",
    acceptanceCriteria: ["Payment failure rate within +3pp of control", "Duplicate submission rate within +3pp of control", "5xx rate within +2pp of control", "Checkout p95 latency under 1.6x control"],
  }, { simulation: true, simResults: fixture, status: "running" });

  let offset = 0;
  let total = 0;
  ctx.db.tx(() => {
    for (const [variant, spec] of Object.entries(scenario.traffic)) {
      for (const k of [0, 1]) {
        const seed = (id === "safe-winner" ? 100 : 200) + k * 10 + ["control", "upi_first", "one_tap"].indexOf(variant);
        // The older window (k = 1) is healthy for every variant, so the dangerous scenario shows a regression that starts recently.
        const windowSpec: Partial<TrafficSpec> = k === 1 ? { conversionRate: spec.conversionRate } : spec;
        const obs = generateTraffic({ variantKey: variant, sessions: SESSIONS_PER_WINDOW, fromMs: now - (k + 1) * W, toMs: now - k * W, ...windowSpec }, seed);
        const events = toEvents(obs, key, id, offset);
        for (const e of events) { ctx.db.insertIfAbsent({ event: e, payloadHash: hashEvent(e) }); total++; }
        offset += events.length + 10;
      }
    }
  });
  return { plan: getPlan(ctx, plan.id), events: total };
}
