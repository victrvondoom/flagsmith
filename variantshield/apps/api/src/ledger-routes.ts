import type { Route } from "./app.ts";
import { HttpError } from "./http.ts";
import { answer, MAX_QUESTION } from "./assistant.ts";
import { buildBrief, snapshotOf, diffKeyFacts, type Scope } from "./briefing.ts";
import { appendEntry, exportLedger, getEntry, listEntries, proposeDecision, resolveDecision, verifyLedger, type SubjectType } from "./ledger.ts";
import type { Snapshot } from "./ledger.ts";
import { getPlan } from "./plans.ts";
import { getContractVersion } from "./contracts.ts";

const obj = (b: unknown): Record<string, unknown> => { if (typeof b !== "object" || b === null || Array.isArray(b)) throw new HttpError(400, "invalid_body", "Body must be a JSON object"); return b as Record<string, unknown>; };

function parseScope(v: unknown): Scope {
  const o = obj(v);
  if (o.type !== "plan" && o.type !== "contract") throw new HttpError(400, "validation_failed", 'scope.type must be "plan" or "contract"');
  if (typeof o.id !== "string" && typeof o.id !== "number") throw new HttpError(400, "validation_failed", "scope.id is required");
  const id = String(o.id);
  if (o.type === "plan" && !/^[1-9]\d{0,9}$/.test(id)) throw new HttpError(400, "validation_failed", "plan id must be a positive integer");
  if (o.type === "contract" && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new HttpError(400, "validation_failed", "contract id must be a lowercase slug");
  return { type: o.type, id };
}

/** Throws 404 when the subject does not exist, so notes and decisions cannot attach to made-up subjects. */
function assertExists(ctx: Parameters<typeof getPlan>[0], s: Scope): void { if (s.type === "plan") getPlan(ctx, Number(s.id)); else getContractVersion(ctx, s.id); }

export const ledgerRoutes: Route[] = [
  {
    method: "GET", pattern: /^\/api\/ledger$/, auth: "admin",
    handler: ({ ctx, query }) => {
      const limit = Number(query.get("limit") ?? 50), before = Number(query.get("before") ?? 0);
      return { entries: listEntries(ctx, { ...(query.get("subjectType") ? { subjectType: query.get("subjectType")! } : {}), ...(query.get("subjectId") ? { subjectId: query.get("subjectId")! } : {}), ...(query.get("kind") ? { kind: query.get("kind")! } : {}), limit: Number.isFinite(limit) ? limit : 50, ...(before > 0 ? { beforeSeq: before } : {}) }) };
    },
  },
  { method: "GET", pattern: /^\/api\/ledger\/verify$/, auth: "admin", heavy: true, handler: ({ ctx }) => verifyLedger(ctx) },
  { method: "GET", pattern: /^\/api\/ledger\/export$/, auth: "admin", heavy: true, handler: ({ ctx, query }) => exportLedger(ctx, { ...(query.get("subjectType") ? { subjectType: query.get("subjectType")! } : {}), ...(query.get("subjectId") ? { subjectId: query.get("subjectId")! } : {}) }) },
  {
    method: "POST", pattern: /^\/api\/ledger\/notes$/, auth: "admin",
    handler: async ({ ctx, body, actor }) => {
      const b = obj(await body()), scope = parseScope(b.scope);
      assertExists(ctx, scope);
      if (typeof b.text !== "string" || b.text.trim().length < 3 || b.text.length > 1000) throw new HttpError(400, "validation_failed", "text must be 3 to 1000 characters");
      const source = scope.type === "plan" ? (getPlan(ctx, Number(scope.id)).isSimulation ? "simulation" : "real") : (getContractVersion(ctx, scope.id).isSimulation ? "simulation" : "real");
      return { entry: appendEntry(ctx, { kind: "note", subjectType: scope.type, subjectId: scope.id, actor, summary: b.text.trim(), source }) };
    },
  },
  {
    method: "POST", pattern: /^\/api\/ledger\/decisions$/, auth: "admin",
    handler: async ({ ctx, body, actor }) => {
      const b = obj(await body()), scope = parseScope(b.scope);
      assertExists(ctx, scope);
      const brief = await buildBrief(ctx, scope);
      return { entry: proposeDecision(ctx, { subjectType: scope.type as SubjectType, subjectId: scope.id, decision: b.decision, rationale: b.rationale, actor, snapshot: snapshotOf(brief), source: brief.source }), basedOn: { fingerprint: brief.fingerprint } };
    },
  },
  {
    method: "POST", pattern: /^\/api\/ledger\/decisions\/(\d+)\/resolve$/, auth: "admin",
    handler: async ({ ctx, params, body, actor }) => {
      const seq = Number(params[0]), b = obj(await body());
      if (b.action !== "approve" && b.action !== "reject") throw new HttpError(400, "validation_failed", 'action must be "approve" or "reject"');
      const p = getEntry(ctx, seq);
      if (!p || p.kind !== "decision.proposed") throw new HttpError(404, "decision_not_found", "No such proposed decision");
      const brief = await buildBrief(ctx, { type: p.subjectType as "plan" | "contract", id: p.subjectId });
      const then = (p.payload.snapshot as Snapshot | undefined)?.facts ?? {};
      const current = snapshotOf(brief);
      const entry = resolveDecision(ctx, { seq, action: b.action, actor, confirmation: b.confirmation, reason: b.reason, acknowledgeChanges: b.acknowledgeChanges === true, current, changes: diffKeyFacts(then, brief.keyFacts) });
      return { entry };
    },
  },
  {
    method: "GET", pattern: /^\/api\/context\/(plan|contract)\/([\w-]{1,64})$/, auth: "admin", heavy: true,
    handler: async ({ ctx, params }) => ({ brief: await buildBrief(ctx, parseScope({ type: params[0], id: params[1] })) }),
  },
  {
    // Read-only: a viewer credential may ask. The answer never changes anything.
    method: "POST", pattern: /^\/api\/assistant\/ask$/, auth: "admin", heavy: true, readOnly: true,
    handler: async ({ ctx, body }) => {
      const b = obj(await body()), scope = parseScope(b.scope);
      if (typeof b.question !== "string" || b.question.length > MAX_QUESTION) throw new HttpError(400, "validation_failed", `question must be a string of at most ${MAX_QUESTION} characters`);
      const brief = await buildBrief(ctx, scope);
      return { answer: answer(brief, b.question), brief: { fingerprint: brief.fingerprint, generatedAt: brief.generatedAt, source: brief.source, title: brief.title } };
    },
  },
];
