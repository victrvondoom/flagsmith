import type { Ctx } from "./context.ts";
import { HttpError } from "./http.ts";
import { mergeConfig, type DeepPartial, type GuardrailConfig } from "../../../packages/guardrail-engine/src/index.ts";
import type { ExperimentResultSummary } from "../../../packages/verdict/src/index.ts";
import type { Row } from "./db.ts";
import { record } from "./ledger.ts";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Plan {
  id: number;
  key: string;
  title: string;
  businessProblem: string;
  hypothesis: string;
  controlVariant: string;
  treatmentVariants: string[];
  primaryMetric: string;
  featureKey: string;
  guardrailOverrides: DeepPartial<GuardrailConfig>;
  acceptanceCriteria: string[];
  owner: string;
  flagsmithExperimentId: number | null;
  lastFlagsmithStatus: string | null;
  lastSyncedAt: number | null;
  approval: { status: ApprovalStatus; by: string | null; at: number | null; note: string | null };
  isSimulation: boolean;
  simResults: ExperimentResultSummary | null;
  createdAt: number;
  updatedAt: number;
}

const json = <T>(v: unknown, fallback: T): T => {
  try { return v ? (JSON.parse(String(v)) as T) : fallback; } catch { return fallback; }
};

export function rowToPlan(r: Row): Plan {
  return {
    id: Number(r.id), key: String(r.key), title: String(r.title), businessProblem: String(r.business_problem), hypothesis: String(r.hypothesis),
    controlVariant: String(r.control_variant), treatmentVariants: json<string[]>(r.treatment_variants, []), primaryMetric: String(r.primary_metric),
    featureKey: String(r.feature_key), guardrailOverrides: json(r.guardrail_overrides, {}), acceptanceCriteria: json<string[]>(r.acceptance_criteria, []),
    owner: String(r.owner), flagsmithExperimentId: r.flagsmith_experiment_id === null ? null : Number(r.flagsmith_experiment_id),
    lastFlagsmithStatus: r.last_flagsmith_status === null ? null : String(r.last_flagsmith_status),
    lastSyncedAt: r.last_synced_at === null ? null : Number(r.last_synced_at),
    approval: { status: String(r.approval_status) as ApprovalStatus, by: r.approval_by === null ? null : String(r.approval_by), at: r.approval_at === null ? null : Number(r.approval_at), note: r.approval_note === null ? null : String(r.approval_note) },
    isSimulation: Number(r.is_simulation) === 1, simResults: json<ExperimentResultSummary | null>(r.sim_results, null),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

export function listPlans(ctx: Ctx): Plan[] {
  return ctx.db.all("SELECT * FROM plans ORDER BY is_simulation, id").map(rowToPlan);
}

export function getPlan(ctx: Ctx, id: number): Plan {
  const r = ctx.db.get("SELECT * FROM plans WHERE id = ?", id);
  if (!r) throw new HttpError(404, "plan_not_found", `No experiment plan with id ${id}`);
  return rowToPlan(r);
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VARIANT = /^[A-Za-z0-9_\-. ]{1,128}$/;

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

export interface PlanInput {
  key?: string; title?: string; businessProblem?: string; hypothesis?: string; controlVariant?: string; treatmentVariants?: string[];
  primaryMetric?: string; featureKey?: string; guardrailOverrides?: DeepPartial<GuardrailConfig>; acceptanceCriteria?: string[]; owner?: string;
}

export function parsePlanInput(body: unknown, creating: boolean): PlanInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_body", "Body must be a JSON object");
  const b = body as Record<string, unknown>;
  const out: PlanInput = {};
  const issues: string[] = [];
  const text = (k: keyof PlanInput, max: number, required = false): void => {
    const v = b[k];
    if (v === undefined) { if (required && creating) issues.push(`${k} is required`); return; }
    if (typeof v !== "string" || v.length > max || (required && v.trim() === "")) { issues.push(`${k} must be a string up to ${max} chars`); return; }
    (out as Record<string, unknown>)[k] = v.trim();
  };
  text("title", 200, true); text("businessProblem", 2000); text("hypothesis", 2000); text("primaryMetric", 200); text("featureKey", 256); text("owner", 100);
  if (b.key !== undefined) {
    if (typeof b.key !== "string" || !SLUG.test(b.key)) issues.push("key must be a lowercase slug (a-z, 0-9, - _)");
    else out.key = b.key;
  } else if (creating && typeof b.title === "string") out.key = slugify(b.title) || "experiment";
  if (b.controlVariant !== undefined) {
    if (typeof b.controlVariant !== "string" || !VARIANT.test(b.controlVariant)) issues.push("controlVariant is invalid");
    else out.controlVariant = b.controlVariant;
  }
  const list = (k: "treatmentVariants" | "acceptanceCriteria", max: number, item: RegExp | null): void => {
    const v = b[k];
    if (v === undefined) return;
    if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || x.length > 500 || (item !== null && !item.test(x)))) { issues.push(`${k} must be an array of up to ${max} valid strings`); return; }
    out[k] = v as string[];
  };
  list("treatmentVariants", 10, VARIANT); list("acceptanceCriteria", 30, null);
  if (b.guardrailOverrides !== undefined) {
    try {
      if (typeof b.guardrailOverrides !== "object" || b.guardrailOverrides === null) throw new RangeError("must be an object");
      mergeConfig(b.guardrailOverrides as DeepPartial<GuardrailConfig>);
      out.guardrailOverrides = b.guardrailOverrides as DeepPartial<GuardrailConfig>;
    } catch (e) { issues.push(`guardrailOverrides: ${e instanceof Error ? e.message : "invalid"}`); }
  }
  if (issues.length) throw new HttpError(400, "validation_failed", "Invalid experiment plan", issues);
  return out;
}

export function createPlan(ctx: Ctx, input: PlanInput, extra: { simulation?: boolean; simResults?: ExperimentResultSummary; flagsmithExperimentId?: number; status?: string } = {}): Plan {
  const now = ctx.now();
  const key = input.key ?? "experiment";
  if (ctx.db.get("SELECT id FROM plans WHERE key = ?", key)) throw new HttpError(409, "plan_exists", `A plan with key "${key}" already exists`);
  const res = ctx.db.run(
    `INSERT INTO plans (key, title, business_problem, hypothesis, control_variant, treatment_variants, primary_metric, feature_key, guardrail_overrides,
       acceptance_criteria, owner, flagsmith_experiment_id, last_flagsmith_status, last_synced_at, is_simulation, sim_results, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    key, input.title ?? key, input.businessProblem ?? "", input.hypothesis ?? "", input.controlVariant ?? "control", JSON.stringify(input.treatmentVariants ?? []),
    input.primaryMetric ?? "", input.featureKey ?? "", JSON.stringify(input.guardrailOverrides ?? {}), JSON.stringify(input.acceptanceCriteria ?? []), input.owner ?? "",
    extra.flagsmithExperimentId ?? null, extra.status ?? null, extra.status ? now : null, extra.simulation ? 1 : 0, extra.simResults ? JSON.stringify(extra.simResults) : null, now, now,
  );
  return getPlan(ctx, res.lastInsertRowid);
}

export function updatePlan(ctx: Ctx, id: number, input: PlanInput): Plan {
  const cur = getPlan(ctx, id);
  const next = { ...cur, ...input };
  if (input.key && input.key !== cur.key && ctx.db.get("SELECT id FROM plans WHERE key = ?", input.key)) throw new HttpError(409, "plan_exists", `A plan with key "${input.key}" already exists`);
  ctx.db.run(
    `UPDATE plans SET key=?, title=?, business_problem=?, hypothesis=?, control_variant=?, treatment_variants=?, primary_metric=?, feature_key=?,
       guardrail_overrides=?, acceptance_criteria=?, owner=?, updated_at=? WHERE id=?`,
    next.key, next.title, next.businessProblem, next.hypothesis, next.controlVariant, JSON.stringify(next.treatmentVariants), next.primaryMetric, next.featureKey,
    JSON.stringify(next.guardrailOverrides), JSON.stringify(next.acceptanceCriteria), next.owner, ctx.now(), id,
  );
  return getPlan(ctx, id);
}

export function deletePlan(ctx: Ctx, id: number): void {
  getPlan(ctx, id);
  ctx.db.run("DELETE FROM plans WHERE id = ?", id);
}

export function setApproval(ctx: Ctx, id: number, decision: ApprovalStatus, actor: string, note: string): Plan {
  getPlan(ctx, id);
  if (decision !== "approved" && decision !== "rejected" && decision !== "pending") throw new HttpError(400, "validation_failed", "decision must be approved, rejected or pending");
  ctx.db.run("UPDATE plans SET approval_status=?, approval_by=?, approval_at=?, approval_note=?, updated_at=? WHERE id=?", decision, decision === "pending" ? null : actor, decision === "pending" ? null : ctx.now(), note.slice(0, 1000), ctx.now(), id);
  const plan = getPlan(ctx, id);
  record(ctx, { kind: "plan.approval", subjectType: "plan", subjectId: String(id), actor, source: plan.isSimulation ? "simulation" : "real", summary: `Plan approval set to ${decision}${note ? `: ${note.slice(0, 200)}` : ""}`, payload: { decision, note: note.slice(0, 1000) } });
  return plan;
}

export function guardrailConfigFor(ctx: Ctx, plan: Plan): GuardrailConfig {
  return mergeConfig({ ...(ctx.cfg.guardrails as DeepPartial<GuardrailConfig>), ...plan.guardrailOverrides, baselineVariant: plan.controlVariant });
}
