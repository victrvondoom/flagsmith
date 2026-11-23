import type { Ctx } from "./context.ts";
import { HttpError } from "./http.ts";
import { getPlan, type Plan } from "./plans.ts";
import { FlagsmithError, type FlagsmithExperimentStatus } from "../../../packages/flagsmith-adapter/src/index.ts";

export type ControlAction = "pause" | "resume" | "complete";

/** Documented Flagsmith lifecycle (api/experimentation/models.py VALID_STATUS_TRANSITIONS). */
const TARGET: Record<ControlAction, { to: FlagsmithExperimentStatus; from: FlagsmithExperimentStatus[]; endpoint: "pause" | "start" | "complete" }> = {
  pause: { to: "paused", from: ["running"], endpoint: "pause" },
  resume: { to: "running", from: ["paused"], endpoint: "start" },
  complete: { to: "completed", from: ["running", "paused"], endpoint: "complete" },
};

export interface ControlRequest {
  planId: number;
  action: ControlAction;
  dryRun: boolean;
  confirmation?: string;
  reason?: string;
  evidenceId?: number;
  actor: string;
}

export interface ControlResult {
  outcome: "dry_run" | "executed";
  simulated: boolean;
  action: ControlAction;
  before: FlagsmithExperimentStatus;
  after: FlagsmithExperimentStatus;
  wouldCall: string;
  auditId: number;
}

const locks = new Set<number>();

export function expectedConfirmation(action: ControlAction, experimentId: number | string): string {
  return `${action.toUpperCase()} ${experimentId}`;
}

function audit(ctx: Ctx, req: ControlRequest, plan: Plan, fields: { outcome: string; before?: string | null; after?: string | null; simulated?: boolean; detail?: unknown }): number {
  return ctx.db.run(
    `INSERT INTO audit (ts, actor, action, plan_id, flagsmith_experiment_id, dry_run, simulated, outcome, reason, evidence_id, before_state, after_state, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ctx.now(), req.actor, req.action, plan.id, plan.flagsmithExperimentId, req.dryRun ? 1 : 0, fields.simulated ? 1 : 0, fields.outcome, req.reason ?? null,
    req.evidenceId ?? null, fields.before ?? null, fields.after ?? null, fields.detail === undefined ? null : JSON.stringify(fields.detail),
  ).lastInsertRowid;
}

function mapFlagsmithError(e: unknown): HttpError {
  if (!(e instanceof FlagsmithError)) return new HttpError(502, "flagsmith_error", "Unexpected error talking to Flagsmith");
  const status = e.kind === "forbidden" ? 403 : e.kind === "auth" ? 401 : e.kind === "validation" ? 409 : e.kind === "not_found" ? 404 : 502;
  const hint = e.kind === "forbidden" || e.kind === "auth" ? " The configured Flagsmith Management API credential lacks permission for this experiment." : "";
  return new HttpError(status, `flagsmith_${e.kind}`, `${e.message}.${hint}`, { flagsmithStatus: e.status });
}

/**
 * Human-approved experiment control.
 * 1. Reads Flagsmith's current state (never assumes).  2. Checks the transition is documented.
 * 3. Dry-run stops here.  4. Requires the exact typed confirmation and a reason.
 * 5. Calls the Flagsmith lifecycle endpoint (no automatic retry).  6. Re-reads Flagsmith and verifies the new state.  Every step is audited.
 */
export async function runControl(ctx: Ctx, req: ControlRequest): Promise<ControlResult> {
  const plan = getPlan(ctx, req.planId);
  const spec = TARGET[req.action];
  if (!spec) throw new HttpError(400, "validation_failed", "action must be pause, resume or complete");
  if (locks.has(plan.id)) throw new HttpError(409, "action_in_progress", "Another control action is already running for this plan");
  locks.add(plan.id);
  try {
    if (plan.isSimulation) return await runSimulated(ctx, req, plan, spec);
    if (plan.flagsmithExperimentId === null) throw new HttpError(409, "not_linked", "This plan is not linked to a Flagsmith experiment");
    if (!ctx.flagsmith) throw new HttpError(503, "flagsmith_not_configured", "Flagsmith is not configured on this VariantShield instance");
    const id = plan.flagsmithExperimentId;
    const wouldCall = `POST /api/v1/environments/{environment_api_key}/experiments/${id}/${spec.endpoint}/`;

    let before;
    try { before = await ctx.flagsmith.getExperiment(id); } catch (e) { audit(ctx, req, plan, { outcome: "inspect_failed", detail: String(e) }); throw mapFlagsmithError(e); }

    if (!spec.from.includes(before.status)) {
      audit(ctx, req, plan, { outcome: "rejected_invalid_transition", before: before.status });
      throw new HttpError(409, "invalid_transition", `Cannot ${req.action}: Flagsmith reports the experiment is "${before.status}" (allowed from: ${spec.from.join(", ")}).`, { current: before.status });
    }
    if (req.dryRun) {
      const auditId = audit(ctx, req, plan, { outcome: "dry_run", before: before.status, after: before.status, detail: { wouldCall, wouldBecome: spec.to } });
      return { outcome: "dry_run", simulated: false, action: req.action, before: before.status, after: before.status, wouldCall, auditId };
    }

    assertHumanConfirmation(ctx, req, plan, id, before.status);

    try { await ctx.flagsmith.transition(id, spec.endpoint === "start" ? "start" : spec.endpoint); } catch (e) {
      audit(ctx, req, plan, { outcome: "flagsmith_call_failed", before: before.status, detail: e instanceof FlagsmithError ? { kind: e.kind, status: e.status } : String(e) });
      throw mapFlagsmithError(e);
    }
    let after;
    try { after = await ctx.flagsmith.getExperiment(id); } catch {
      audit(ctx, req, plan, { outcome: "verification_unavailable", before: before.status });
      throw new HttpError(502, "verification_unavailable", "The action was sent but Flagsmith's new state could not be read back. Check Flagsmith before retrying.", { before: before.status });
    }
    if (after.status !== spec.to) {
      audit(ctx, req, plan, { outcome: "verification_failed", before: before.status, after: after.status });
      throw new HttpError(502, "verification_failed", `Flagsmith still reports "${after.status}" after the ${req.action}; expected "${spec.to}".`, { before: before.status, after: after.status });
    }
    ctx.db.run("UPDATE plans SET last_flagsmith_status=?, last_synced_at=?, updated_at=? WHERE id=?", after.status, ctx.now(), ctx.now(), plan.id);
    const auditId = audit(ctx, req, plan, { outcome: "executed", before: before.status, after: after.status });
    return { outcome: "executed", simulated: false, action: req.action, before: before.status, after: after.status, wouldCall, auditId };
  } finally {
    locks.delete(plan.id);
  }
}

function assertHumanConfirmation(ctx: Ctx, req: ControlRequest, plan: Plan, id: number | string, before: string): void {
  const expected = expectedConfirmation(req.action, id);
  if (req.confirmation !== expected) {
    audit(ctx, req, plan, { outcome: "rejected_missing_confirmation", before });
    throw new HttpError(400, "confirmation_required", `Type "${expected}" to confirm this action.`, { expected });
  }
  if (!req.reason || req.reason.trim().length < 10) {
    audit(ctx, req, plan, { outcome: "rejected_missing_reason", before });
    throw new HttpError(400, "reason_required", "A reason of at least 10 characters is required for the audit record.");
  }
}

/** Simulated plans never touch Flagsmith; the audit row is marked simulated so it cannot be mistaken for a real action. */
async function runSimulated(ctx: Ctx, req: ControlRequest, plan: Plan, spec: (typeof TARGET)[ControlAction]): Promise<ControlResult> {
  const before = (plan.lastFlagsmithStatus ?? "running") as FlagsmithExperimentStatus;
  const wouldCall = "(simulation) no Flagsmith call is made";
  if (!spec.from.includes(before)) {
    audit(ctx, req, plan, { outcome: "rejected_invalid_transition", before, simulated: true });
    throw new HttpError(409, "invalid_transition", `Cannot ${req.action}: simulated experiment is "${before}".`, { current: before });
  }
  if (req.dryRun) {
    const auditId = audit(ctx, req, plan, { outcome: "dry_run", before, after: before, simulated: true });
    return { outcome: "dry_run", simulated: true, action: req.action, before, after: before, wouldCall, auditId };
  }
  assertHumanConfirmation(ctx, req, plan, plan.key, before);
  ctx.db.run("UPDATE plans SET last_flagsmith_status=?, last_synced_at=?, updated_at=? WHERE id=?", spec.to, ctx.now(), ctx.now(), plan.id);
  const auditId = audit(ctx, req, plan, { outcome: "executed", before, after: spec.to, simulated: true });
  return { outcome: "executed", simulated: true, action: req.action, before, after: spec.to, wouldCall, auditId };
}
