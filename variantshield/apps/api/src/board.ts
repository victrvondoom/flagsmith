import type { Ctx } from "./context.ts";
import { listPlans, type Plan } from "./plans.ts";
import { reliabilityFor, type SourceFilter } from "./reliability.ts";
import { worstStatus, type GuardrailStatus } from "../../../packages/guardrail-engine/src/index.ts";
import { FlagsmithError, type FlagsmithExperimentStatus } from "../../../packages/flagsmith-adapter/src/index.ts";

export type BoardState = "PLANNED" | "CONFIGURED" | "QUALIFYING" | "RUNNING" | "WARNING" | "BREACH" | "PAUSED" | "COMPLETED";

export interface BenchSummary {
  runId: string | null;
  status: "none" | "running" | "passed" | "failed" | "errored";
  variants: Record<string, { passed: number; failed: number; total: number }>;
}

export function benchSummary(ctx: Ctx): BenchSummary {
  const run = ctx.db.get("SELECT id, status FROM bench_runs ORDER BY started_at DESC LIMIT 1");
  if (!run) return { runId: null, status: "none", variants: {} };
  const variants: BenchSummary["variants"] = {};
  for (const r of ctx.db.all("SELECT variant, status, COUNT(*) AS n FROM bench_results WHERE run_id = ? GROUP BY variant, status", String(run.id))) {
    const v = (variants[String(r.variant)] ??= { passed: 0, failed: 0, total: 0 });
    v.total += Number(r.n);
    if (r.status === "passed") v.passed += Number(r.n); else v.failed += Number(r.n);
  }
  const s = String(run.status);
  return { runId: String(run.id), status: s === "running" ? "running" : s === "errored" ? "errored" : Object.values(variants).every((v) => v.failed === 0) ? "passed" : "failed", variants };
}

/** Pure derivation of the board column from backend facts. */
export function deriveBoardState(input: { linked: boolean; flagsmithStatus: FlagsmithExperimentStatus | null; bench: BenchSummary; reliability: GuardrailStatus | null }): BoardState {
  if (!input.linked || input.flagsmithStatus === null) return "PLANNED";
  switch (input.flagsmithStatus) {
    case "created": return input.bench.status === "running" || input.bench.status === "failed" || input.bench.status === "errored" ? "QUALIFYING" : "CONFIGURED";
    case "running":
      if (input.reliability === "BREACH") return "BREACH";
      if (input.reliability === "WARNING" || input.reliability === "RECOVERING") return "WARNING";
      return "RUNNING";
    case "paused": return "PAUSED";
    case "completed": return "COMPLETED";
  }
}

export interface BoardCard {
  plan: Plan;
  state: BoardState;
  flagsmith: { status: FlagsmithExperimentStatus | null; stale: boolean; syncedAt: number | null; error: string | null; simulated: boolean };
  reliability: GuardrailStatus | null;
  source: SourceFilter;
}

async function syncStatus(ctx: Ctx, plan: Plan): Promise<BoardCard["flagsmith"]> {
  if (plan.isSimulation) return { status: plan.lastFlagsmithStatus as FlagsmithExperimentStatus | null, stale: false, syncedAt: plan.lastSyncedAt, error: null, simulated: true };
  if (plan.flagsmithExperimentId === null) return { status: null, stale: false, syncedAt: null, error: null, simulated: false };
  const cached = (plan.lastFlagsmithStatus as FlagsmithExperimentStatus | null) ?? null;
  if (!ctx.flagsmith) return { status: cached, stale: true, syncedAt: plan.lastSyncedAt, error: "Flagsmith is not configured", simulated: false };
  try {
    const exp = await ctx.flagsmith.getExperiment(plan.flagsmithExperimentId);
    ctx.db.run("UPDATE plans SET last_flagsmith_status=?, last_synced_at=? WHERE id=?", exp.status, ctx.now(), plan.id);
    return { status: exp.status, stale: false, syncedAt: ctx.now(), error: null, simulated: false };
  } catch (e) {
    return { status: cached, stale: true, syncedAt: plan.lastSyncedAt, error: e instanceof FlagsmithError ? `${e.kind}: ${e.message}` : "unknown error", simulated: false };
  }
}

export async function buildBoard(ctx: Ctx): Promise<{ cards: BoardCard[]; bench: BenchSummary }> {
  const bench = benchSummary(ctx);
  const cards = await Promise.all(listPlans(ctx).map(async (plan): Promise<BoardCard> => {
    const flagsmith = await syncStatus(ctx, plan);
    const source: SourceFilter = plan.isSimulation ? "simulation" : "real";
    const reliability = flagsmith.status === "running" || flagsmith.status === "paused" ? worstStatus(reliabilityFor(ctx, plan, source).variants.map((v) => v.status)) : null;
    return { plan, flagsmith, reliability, source, state: deriveBoardState({ linked: plan.isSimulation || plan.flagsmithExperimentId !== null, flagsmithStatus: flagsmith.status, bench, reliability }) };
  }));
  return { cards, bench };
}
