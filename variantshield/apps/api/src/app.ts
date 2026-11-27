import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import type { Ctx } from "./context.ts";
import { bearer, HttpError, readJson, SECURITY_HEADERS, sendError, sendJson, tokenMatches } from "./http.ts";
import { createPlan, deletePlan, getPlan, listPlans, parsePlanInput, setApproval, updatePlan, type ApprovalStatus } from "./plans.ts";
import { reliabilityFor, timelineFor, verdictFor, type SourceFilter } from "./reliability.ts";
import { buildBoard } from "./board.ts";
import { runControl, expectedConfirmation, type ControlAction } from "./control.ts";
import { benchRunDetail, screenshotPath, startBenchRun, type Fault } from "./bench.ts";
import { runScenario, SCENARIOS } from "./simulation.ts";
import { ingest } from "../../../packages/telemetry/src/index.ts";
import { RateLimiter } from "../../../packages/telemetry/src/index.ts";
import { FlagsmithError } from "../../../packages/flagsmith-adapter/src/index.ts";
import { contractRoutes } from "./contract-routes.ts";
import { ledgerRoutes } from "./ledger-routes.ts";
import { record } from "./ledger.ts";
import { verifySurfaceKey, type SurfaceBinding } from "./surface-keys.ts";
import * as metrics from "./metrics.ts";
import { bisectRoutes } from "./bisect/routes.ts";
import { BisectRuntime } from "./bisect/runtime.ts";
import { FlagsmithControl } from "./bisect/flagsmith-control.ts";

/** `ingest` accepts the master ingest key or a per-surface key; `surface` accepts only a per-surface key bound to one (contract, surface). */
export type Auth = "public" | "admin" | "ingest" | "surface" | "issuer";
export interface Route {
  method: string; pattern: RegExp; auth: Auth; handler: (h: HandlerArgs) => Promise<unknown> | unknown; raw?: boolean;
  /** Not available to the read-only viewer credential (e.g. anything that reveals keys). */
  adminOnly?: boolean;
  /** A POST that only reads: allowed for the read-only viewer credential. */
  readOnly?: boolean;
  /** CPU-heavy read; rate limited separately because evaluation runs on the single request thread. */
  heavy?: boolean;
}
export interface HandlerArgs {
  ctx: Ctx; req: IncomingMessage; res: ServerResponse; params: string[]; query: URLSearchParams; body: () => Promise<unknown>; actor: string;
  /** Set for per-surface keys. */
  surface: SurfaceBinding | null;
  /** Charges `units` against the caller's quota (e.g. observations in a batch); throws 429 when exhausted. */
  charge: (units: number) => void;
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const PUBLIC_DIR = resolve(import.meta.dirname, "../../dashboard/public");
const VERSION = "0.1.0";

const source = (q: URLSearchParams): SourceFilter => {
  const s = q.get("source") ?? "real";
  if (s !== "real" && s !== "simulation") throw new HttpError(400, "validation_failed", 'source must be "real" or "simulation"');
  return s;
};
const intParam = (v: string | undefined, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "validation_failed", `${name} must be a positive integer`);
  return n;
};
const obj = (b: unknown): Record<string, unknown> => {
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw new HttpError(400, "invalid_body", "Body must be a JSON object");
  return b as Record<string, unknown>;
};
const need = (ctx: Ctx) => {
  if (!ctx.flagsmith) throw new HttpError(503, "flagsmith_not_configured", "Set FLAGSMITH_URL, FLAGSMITH_ENVIRONMENT_KEY and a Management API credential to use Flagsmith features.");
  return ctx.flagsmith;
};
const wrapFs = async <T>(p: Promise<T>): Promise<T> => {
  try { return await p; } catch (e) {
    if (e instanceof FlagsmithError) throw new HttpError(e.kind === "forbidden" ? 403 : e.kind === "auth" ? 401 : e.kind === "not_found" ? 404 : 502, `flagsmith_${e.kind}`, e.message);
    throw e;
  }
};

const probe = { at: 0, value: { state: "unknown" as "ok" | "error" | "not_configured" | "unknown", message: "" } };
async function flagsmithHealth(ctx: Ctx): Promise<typeof probe.value> {
  if (!ctx.flagsmith) return { state: "not_configured", message: "FLAGSMITH_URL or FLAGSMITH_ENVIRONMENT_KEY is not set" };
  if (ctx.now() - probe.at < 10_000) return probe.value;
  try {
    await ctx.flagsmith.listExperiments({ maxPages: 1 });
    probe.value = { state: "ok", message: "Flagsmith Management API reachable" };
  } catch (e) {
    probe.value = { state: "error", message: e instanceof FlagsmithError ? `${e.kind}: ${e.message}` : "unreachable" };
  }
  probe.at = ctx.now();
  return probe.value;
}

const routes: Route[] = [
  { method: "GET", pattern: /^\/health$/, auth: "public", handler: () => ({ status: "ok", version: VERSION }) },
  {
    method: "GET", pattern: /^\/ready$/, auth: "public",
    handler: async ({ ctx }) => {
      ctx.db.get("SELECT 1 AS ok");
      return { status: "ready", database: "ok", flagsmith: await flagsmithHealth(ctx) };
    },
  },
  { method: "GET", pattern: /^\/api\/public-config$/, auth: "public", handler: ({ ctx }) => ({ version: VERSION, demoMode: ctx.cfg.demoMode, flagsmithConfigured: ctx.flagsmith !== null }) },

  {
    method: "POST", pattern: /^\/api\/ingest$/, auth: "ingest",
    handler: async ({ ctx, body }) => {
      const b = obj(await body());
      const maxAgeMs = ctx.cfg.retentionDays * 86_400_000;
      try {
        return ingest(b.events, ctx.db, { nowMs: ctx.now(), maxAgeMs, maxFutureSkewMs: 300_000 });
      } catch (e) {
        if (e instanceof RangeError) throw new HttpError(400, "validation_failed", e.message);
        throw e;
      }
    },
  },

  {
    // Prometheus exposition. Needs the admin or viewer credential (use `authorization: Bearer` in the scrape config).
    method: "GET", pattern: /^\/metrics$/, auth: "admin", raw: true,
    handler: ({ ctx, res }) => {
      const n = (sql: string): number => Number((ctx.db.get(sql) as { n: number } | undefined)?.n ?? 0);
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
      res.end(metrics.render({
        contract_observations_stored: n("SELECT COUNT(*) AS n FROM contract_observations"),
        telemetry_events_stored: n("SELECT COUNT(*) AS n FROM events"),
        contract_findings_stored: n("SELECT COUNT(*) AS n FROM contract_findings"),
      }));
    },
  },
  {
    // Read-only view of how this instance is wired. Reports whether secrets are set, never their values.
    method: "GET", pattern: /^\/api\/integration$/, auth: "admin",
    handler: async ({ ctx }) => {
      const fs = ctx.flagsmith;
      return {
        version: VERSION,
        demoMode: ctx.cfg.demoMode,
        flagsmith: {
          configured: fs !== null,
          ...(fs ? fs.describe() : { baseUrl: ctx.cfg.flagsmith.url, environmentKey: null, adminConfigured: false }),
          health: await flagsmithHealth(ctx),
        },
        secrets: { adminToken: true, ingestKey: true, identitySecret: true, identityIssuerKey: true, identityTokenSecret: true, viewerToken: ctx.cfg.viewerToken !== null, ephemeral: ctx.cfg.ephemeralSecrets },
        ledger: { entries: Number((ctx.db.get("SELECT COUNT(*) AS n FROM ledger_entries") as { n: number } | undefined)?.n ?? 0), signedWithRotatableKey: true, allowSelfApproval: ctx.cfg.allowSelfApproval },
        limits: { maxObservationsPerContract: ctx.cfg.maxObservationsPerContract, historyRetentionDays: ctx.cfg.historyRetentionDays, trustProxy: ctx.cfg.trustProxy },
        retentionDays: ctx.cfg.retentionDays,
        corsOrigins: ctx.cfg.corsOrigins,
        contracts: { registered: Number((ctx.db.get("SELECT COUNT(DISTINCT id) AS n FROM contracts") as { n: number } | undefined)?.n ?? 0) },
        endpoints: {
          ingest: { path: "/api/ingest", auth: "X-Ingest-Key" },
          ledger: { path: "/api/ledger, /api/context/:type/:id, /api/assistant/ask", auth: "Authorization: Bearer (viewer may read and ask; admin may record)" },
          contractObservations: { path: "/api/contract-observations", auth: "X-Surface-Key (per surface)" },
          metrics: { path: "/metrics", auth: "Authorization: Bearer (admin or viewer)" },
          identityIssue: { path: "/api/identity/issue", auth: "X-Identity-Issuer-Key" },
          identityVerify: { path: "/api/identity/verify", auth: "X-Surface-Key or X-Ingest-Key" },
        },
      };
    },
  },
  {
    method: "GET", pattern: /^\/api\/overview$/, auth: "admin",
    handler: async ({ ctx }) => {
      const board = await buildBoard(ctx);
      const counts: Record<string, number> = {};
      for (const c of board.cards) counts[c.state] = (counts[c.state] ?? 0) + 1;
      const volume = ctx.db.all("SELECT source, attribution, COUNT(*) AS n FROM events GROUP BY source, attribution");
      const alerts = board.cards.filter((c) => c.state === "BREACH" || c.state === "WARNING").map((c) => ({ planId: c.plan.id, title: c.plan.title, state: c.state, simulated: c.plan.isSimulation }));
      return {
        flagsmith: { configured: ctx.flagsmith !== null, ...(ctx.flagsmith ? ctx.flagsmith.describe() : {}), health: await flagsmithHealth(ctx) },
        counts, alerts, eventVolume: volume, bench: board.bench, demoMode: ctx.cfg.demoMode,
        recentAudit: ctx.db.all("SELECT id, ts, actor, action, plan_id, outcome, dry_run, simulated FROM audit ORDER BY id DESC LIMIT 8"),
      };
    },
  },
  { method: "GET", pattern: /^\/api\/board$/, auth: "admin", handler: ({ ctx }) => buildBoard(ctx) },
  { method: "GET", pattern: /^\/api\/plans$/, auth: "admin", handler: ({ ctx }) => ({ plans: listPlans(ctx) }) },
  { method: "POST", pattern: /^\/api\/plans$/, auth: "admin", handler: async ({ ctx, body }) => ({ plan: createPlan(ctx, parsePlanInput(await body(), true)) }) },
  { method: "GET", pattern: /^\/api\/plans\/(\d+)$/, auth: "admin", handler: ({ ctx, params }) => ({ plan: getPlan(ctx, intParam(params[0], "id")) }) },
  { method: "PATCH", pattern: /^\/api\/plans\/(\d+)$/, auth: "admin", handler: async ({ ctx, params, body }) => ({ plan: updatePlan(ctx, intParam(params[0], "id"), parsePlanInput(await body(), false)) }) },
  { method: "DELETE", pattern: /^\/api\/plans\/(\d+)$/, auth: "admin", handler: ({ ctx, params }) => { deletePlan(ctx, intParam(params[0], "id")); return { deleted: true }; } },
  {
    method: "POST", pattern: /^\/api\/plans\/(\d+)\/link$/, auth: "admin",
    handler: async ({ ctx, params, body }) => {
      const plan = getPlan(ctx, intParam(params[0], "id"));
      if (plan.isSimulation) throw new HttpError(409, "simulation_plan", "Simulation plans cannot be linked to Flagsmith");
      const fid = intParam(String(obj(await body()).flagsmithExperimentId), "flagsmithExperimentId");
      const exp = await wrapFs(need(ctx).getExperiment(fid));
      ctx.db.run("UPDATE plans SET flagsmith_experiment_id=?, last_flagsmith_status=?, last_synced_at=?, feature_key=CASE WHEN feature_key='' THEN ? ELSE feature_key END, updated_at=? WHERE id=?", fid, exp.status, ctx.now(), exp.featureName ?? "", ctx.now(), plan.id);
      return { plan: getPlan(ctx, plan.id), flagsmith: exp };
    },
  },
  { method: "POST", pattern: /^\/api\/plans\/(\d+)\/unlink$/, auth: "admin", handler: ({ ctx, params }) => { const id = intParam(params[0], "id"); getPlan(ctx, id); ctx.db.run("UPDATE plans SET flagsmith_experiment_id=NULL, last_flagsmith_status=NULL, last_synced_at=NULL WHERE id=?", id); return { plan: getPlan(ctx, id) }; } },
  {
    method: "POST", pattern: /^\/api\/plans\/import-flagsmith$/, auth: "admin",
    handler: async ({ ctx }) => {
      const list = await wrapFs(need(ctx).listExperiments());
      const created = [];
      for (const e of list) {
        if (ctx.db.get("SELECT id FROM plans WHERE flagsmith_experiment_id = ?", e.id)) continue;
        const key = `flagsmith-${e.id}`;
        if (ctx.db.get("SELECT id FROM plans WHERE key = ?", key)) continue;
        created.push(createPlan(ctx, { key, title: e.name, hypothesis: e.hypothesis, featureKey: e.featureName ?? "", controlVariant: "control", treatmentVariants: e.variantOptions.filter((v) => v !== "control") }, { flagsmithExperimentId: e.id, status: e.status }));
      }
      return { imported: created.length, plans: created };
    },
  },
  {
    method: "POST", pattern: /^\/api\/plans\/(\d+)\/approval$/, auth: "admin",
    handler: async ({ ctx, params, body, actor }) => {
      const b = obj(await body());
      return { plan: setApproval(ctx, intParam(params[0], "id"), b.decision as ApprovalStatus, actor, typeof b.note === "string" ? b.note : "") };
    },
  },
  { method: "GET", pattern: /^\/api\/plans\/(\d+)\/reliability$/, auth: "admin", heavy: true, handler: ({ ctx, params, query }) => { const plan = getPlan(ctx, intParam(params[0], "id")); const src = query.get("source") ? source(query) : plan.isSimulation ? "simulation" : "real"; return { source: src, report: reliabilityFor(ctx, plan, src) }; } },
  { method: "GET", pattern: /^\/api\/plans\/(\d+)\/timeline$/, auth: "admin", heavy: true, handler: ({ ctx, params, query }) => { const plan = getPlan(ctx, intParam(params[0], "id")); const src = query.get("source") ? source(query) : plan.isSimulation ? "simulation" : "real"; return { source: src, timeline: timelineFor(ctx, plan, src, query.get("buckets") ? Number(query.get("buckets")) : 12) }; } },
  { method: "GET", pattern: /^\/api\/plans\/(\d+)\/verdict$/, auth: "admin", heavy: true, handler: async ({ ctx, params, query }) => { const plan = getPlan(ctx, intParam(params[0], "id")); const src = query.get("source") ? source(query) : plan.isSimulation ? "simulation" : "real"; return verdictFor(ctx, plan, src); } },
  {
    method: "POST", pattern: /^\/api\/plans\/(\d+)\/evidence$/, auth: "admin",
    handler: async ({ ctx, params, actor }) => {
      const plan = getPlan(ctx, intParam(params[0], "id"));
      const src: SourceFilter = plan.isSimulation ? "simulation" : "real";
      const snapshot = { capturedAt: ctx.now(), source: src, simulated: plan.isSimulation, plan: { id: plan.id, key: plan.key, title: plan.title }, ...(await verdictFor(ctx, plan, src)), bench: benchRunSnapshot(ctx) };
      const id = ctx.db.run("INSERT INTO evidence (plan_id, kind, created_at, created_by, payload) VALUES (?,?,?,?,?)", plan.id, "verdict_snapshot", ctx.now(), actor, JSON.stringify(snapshot)).lastInsertRowid;
      record(ctx, { kind: "evidence.snapshot", subjectType: "plan", subjectId: String(plan.id), actor, source: src, summary: `Evidence snapshot #${id}: ${snapshot.verdict.outcome.replaceAll("_", " ")}. ${snapshot.verdict.headline}`, payload: { evidenceId: id, outcome: snapshot.verdict.outcome, recommendedAction: snapshot.verdict.recommendedAction, reliability: snapshot.verdict.reliabilityVerdict.status } });
      return { id, snapshot };
    },
  },
  { method: "GET", pattern: /^\/api\/plans\/(\d+)\/evidence$/, auth: "admin", handler: ({ ctx, params }) => ({ evidence: ctx.db.all("SELECT id, kind, created_at, created_by FROM evidence WHERE plan_id = ? ORDER BY id DESC", intParam(params[0], "id")) }) },
  { method: "GET", pattern: /^\/api\/evidence\/(\d+)$/, auth: "admin", handler: ({ ctx, params }) => { const r = ctx.db.get("SELECT * FROM evidence WHERE id = ?", intParam(params[0], "id")); if (!r) throw new HttpError(404, "evidence_not_found", "No such evidence record"); return { id: r.id, kind: r.kind, createdAt: r.created_at, createdBy: r.created_by, payload: JSON.parse(String(r.payload)) }; } },
  {
    method: "GET", pattern: /^\/api\/events\/summary$/, auth: "admin",
    handler: ({ ctx, query }) => {
      const src = source(query);
      return {
        source: src,
        byType: ctx.db.all("SELECT type, variant_key, COUNT(*) AS n FROM events WHERE source = ? GROUP BY type, variant_key ORDER BY type, variant_key", src),
        byAttribution: ctx.db.all("SELECT attribution, COUNT(*) AS n FROM events WHERE source = ? GROUP BY attribution", src),
        recent: ctx.db.all("SELECT event_id, type, experiment_id, variant_key, attribution, outcome, latency_ms, timestamp_ms FROM events WHERE source = ? ORDER BY timestamp_ms DESC LIMIT 25", src),
      };
    },
  },
  {
    method: "GET", pattern: /^\/api\/control\/(\d+)\/status$/, auth: "admin",
    handler: async ({ ctx, params }) => {
      const plan = getPlan(ctx, intParam(params[0], "id"));
      if (plan.isSimulation) return { simulated: true, status: plan.lastFlagsmithStatus, experimentId: plan.key, confirmations: { pause: expectedConfirmation("pause", plan.key), resume: expectedConfirmation("resume", plan.key), complete: expectedConfirmation("complete", plan.key) } };
      if (plan.flagsmithExperimentId === null) throw new HttpError(409, "not_linked", "This plan is not linked to a Flagsmith experiment");
      const exp = await wrapFs(need(ctx).getExperiment(plan.flagsmithExperimentId));
      const id = plan.flagsmithExperimentId;
      return { simulated: false, status: exp.status, experimentId: id, startedAt: exp.startedAt, endedAt: exp.endedAt, confirmations: { pause: expectedConfirmation("pause", id), resume: expectedConfirmation("resume", id), complete: expectedConfirmation("complete", id) } };
    },
  },
  {
    method: "POST", pattern: /^\/api\/control$/, auth: "admin",
    handler: async ({ ctx, body, actor }) => {
      const b = obj(await body());
      if (!["pause", "resume", "complete"].includes(String(b.action))) throw new HttpError(400, "validation_failed", "action must be pause, resume or complete");
      if (typeof b.dryRun !== "boolean") throw new HttpError(400, "validation_failed", "dryRun must be explicitly true or false");
      return runControl(ctx, {
        planId: intParam(String(b.planId), "planId"), action: b.action as ControlAction, dryRun: b.dryRun, actor,
        ...(typeof b.confirmation === "string" ? { confirmation: b.confirmation } : {}), ...(typeof b.reason === "string" ? { reason: b.reason } : {}),
        ...(Number.isInteger(b.evidenceId) ? { evidenceId: b.evidenceId as number } : {}),
      });
    },
  },
  { method: "GET", pattern: /^\/api\/audit$/, auth: "admin", handler: ({ ctx }) => ({ audit: ctx.db.all("SELECT * FROM audit ORDER BY id DESC LIMIT 200") }) },
  { method: "GET", pattern: /^\/api\/flagsmith\/experiments$/, auth: "admin", handler: async ({ ctx }) => ({ experiments: await wrapFs(need(ctx).listExperiments()) }) },
  { method: "GET", pattern: /^\/api\/bench\/runs$/, auth: "admin", handler: ({ ctx }) => ({ runs: ctx.db.all("SELECT id, status, started_at, finished_at, target, fault, summary FROM bench_runs ORDER BY started_at DESC LIMIT 30") }) },
  { method: "POST", pattern: /^\/api\/bench\/runs$/, auth: "admin", handler: async ({ ctx, body }) => { const b = obj(await body()); return startBenchRun(ctx, { fault: (b.fault ?? "none") as Fault, ...(typeof b.target === "string" ? { target: b.target } : {}) }); } },
  { method: "GET", pattern: /^\/api\/bench\/runs\/([0-9a-f-]{36})$/, auth: "admin", handler: ({ ctx, params }) => benchRunDetail(ctx, params[0]!) },
  {
    method: "GET", pattern: /^\/api\/bench\/runs\/([0-9a-f-]{36})\/screenshots\/([\w.-]+)$/, auth: "admin", raw: true,
    handler: ({ ctx, res, params }) => {
      const p = screenshotPath(ctx, params[0]!, params[1]!);
      res.writeHead(200, { "content-type": "image/png", "cache-control": "private, max-age=300", ...SECURITY_HEADERS });
      createReadStream(p).pipe(res);
    },
  },
  { method: "GET", pattern: /^\/api\/simulate\/scenarios$/, auth: "admin", handler: ({ ctx }) => ({ enabled: ctx.cfg.demoMode, label: "SIMULATION: deterministic synthetic data, never mixed with real observations", scenarios: SCENARIOS.map(({ id, title, description }) => ({ id, title, description })) }) },
  { method: "POST", pattern: /^\/api\/simulate\/([\w-]+)$/, auth: "admin", handler: ({ ctx, params }) => { if (!ctx.cfg.demoMode) throw new HttpError(403, "demo_disabled", "Simulation is disabled (VARIANTSHIELD_DEMO_MODE=false)"); return runScenario(ctx, params[0]!); } },
];

routes.push(...contractRoutes, ...ledgerRoutes, ...bisectRoutes);

function benchRunSnapshot(ctx: Ctx): unknown {
  const run = ctx.db.get("SELECT id, status, fault FROM bench_runs WHERE status IN ('passed','failed') ORDER BY started_at DESC LIMIT 1");
  return run ? { runId: run.id, status: run.status, fault: run.fault } : null;
}

function serveStatic(res: ServerResponse, pathname: string): boolean {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[\w.-]+$/.test(name)) return false;
  const file = join(PUBLIC_DIR, name);
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", ...SECURITY_HEADERS });
  createReadStream(file).pipe(res);
  return true;
}

export interface App { server: Server; ctx: Ctx }

const clientIp = (req: IncomingMessage, trustProxy: boolean): string => {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const last = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((x) => x.trim()).filter(Boolean).pop();
    if (last && last.length <= 64) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
};

export function createApp(ctx: Ctx): App {
  ctx.bisect ??= new BisectRuntime(ctx, ctx.flagsmith ? new FlagsmithControl(ctx.flagsmith, ctx.db) : null);
  const ingestLimiter = new RateLimiter({ capacity: 200, refillPerSecond: 100 });
  const adminLimiter = new RateLimiter({ capacity: 120, refillPerSecond: 30 });
  const controlLimiter = new RateLimiter({ capacity: 10, refillPerSecond: 0.2 });
  // Failed authentication is throttled per client before any credential is compared: 10 failures, then one attempt per 5 s.
  const authFailLimiter = new RateLimiter({ capacity: 10, refillPerSecond: 0.2 });
  // Per-surface quota in observations (not requests), so batching cannot bypass the rate limit.
  const surfaceQuota = new RateLimiter({ capacity: 2000, refillPerSecond: 500 });
  const heavyLimiter = new RateLimiter({ capacity: 30, refillPerSecond: 2 });
  const throttle = (limiter: RateLimiter, key: string, cost = 1): void => {
    const wait = limiter.take(key, Date.now(), cost);
    if (wait > 0) { metrics.inc("rate_limited_total"); throw new HttpError(429, "rate_limited", "Too many requests", { retryAfterMs: wait }); }
  };

  const server = createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    const started = Date.now();
    const requestId = randomUUID();
    const url = new URL(req.url ?? "/", "http://localhost");
    const origin = req.headers.origin;
    const cors: Record<string, string> = origin && ctx.cfg.corsOrigins.includes(origin)
      ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-headers": "authorization, content-type, x-ingest-key, x-surface-key, x-identity-issuer-key, x-variantshield-actor", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" }
      : {};
    res.setHeader("x-request-id", requestId);
    for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...cors })) res.setHeader(k, v);
    if (ctx.cfg.trustProxy && req.headers["x-forwarded-proto"] === "https") res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    let status = 500;
    try {
      if (req.method === "OPTIONS") { res.writeHead(204).end(); status = 204; return; }
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) {
        if (req.method === "GET" && !url.pathname.startsWith("/api/") && serveStatic(res, url.pathname)) { status = 200; return; }
        throw new HttpError(404, "not_found", "Not found");
      }
      const ip = clientIp(req, ctx.cfg.trustProxy);
      // One lockout bucket per credential class and client, so failed surface keys cannot lock the admin out (and vice versa).
      const failKey = `fail:${route.auth === "surface" ? "ingest" : route.auth}:${ip}`;
      let surface: SurfaceBinding | null = null;
      let charge: (units: number) => void = () => {};
      if (route.auth !== "public") {
        const wait = authFailLimiter.peek(failKey, Date.now());
        if (wait > 0) { metrics.inc("auth_lockouts_total"); throw new HttpError(429, "too_many_auth_failures", "Too many failed authentication attempts; try again shortly", { retryAfterMs: wait }); }
      }
      const reject = (msg: string): never => { authFailLimiter.take(failKey, Date.now()); metrics.inc("auth_failures_total", { kind: route.auth }); throw new HttpError(401, "unauthorized", msg); };
      if (route.auth === "issuer") {
        if (!tokenMatches(req.headers["x-identity-issuer-key"] as string | undefined, ctx.cfg.identityIssuerKey)) reject("Missing or invalid identity issuer key");
        throttle(adminLimiter, `issuer:${ip}`);
      } else if (route.auth === "ingest" || route.auth === "surface") {
        surface = verifySurfaceKey(ctx.cfg.ingestKey, req.headers["x-surface-key"]);
        const master = route.auth === "ingest" && tokenMatches(req.headers["x-ingest-key"] as string | undefined, ctx.cfg.ingestKey);
        if (!surface && !master) reject(route.auth === "surface" ? "Missing or invalid surface key (the master ingest key cannot report observations)" : "Missing or invalid ingest or surface key");
        if (surface) {
          const sk = `surface:${surface.contractId}:${surface.surfaceId}`;
          throttle(ingestLimiter, sk);
          charge = (units) => throttle(surfaceQuota, sk, units);
        } else throttle(ingestLimiter, `ingest:${ip}`);
      } else if (route.auth === "admin") {
        const given = bearer(req);
        if (tokenMatches(given, ctx.cfg.adminToken)) { /* full access */ }
        else if (ctx.cfg.viewerToken !== null && tokenMatches(given, ctx.cfg.viewerToken)) {
          if ((req.method !== "GET" && !route.readOnly) || route.adminOnly) throw new HttpError(403, "forbidden", "The read-only credential cannot do this");
        } else reject("Missing or invalid admin token");
        throttle(adminLimiter, `admin:${ip}`);
        if (route.heavy) throttle(heavyLimiter, `heavy:${ip}`);
        if (req.method !== "GET" && url.pathname === "/api/control") throttle(controlLimiter, `control:${ip}`);
      }
      const rawActor = String(req.headers["x-variantshield-actor"] ?? "");
      const actor = /^[\w .@-]{1,64}$/.test(rawActor) ? rawActor : "admin";
      const match = url.pathname.match(route.pattern)!;
      let parsed: Promise<unknown> | null = null;
      const result = await route.handler({ ctx, req, res, params: match.slice(1), query: url.searchParams, body: () => (parsed ??= readJson(req)), actor, surface, charge });
      if (route.raw) { status = 200; return; }
      status = 200;
      sendJson(res, 200, result);
    } catch (e) {
      status = e instanceof HttpError ? e.status : 500;
      if (e instanceof HttpError && e.status === 429) res.setHeader("retry-after", String(Math.ceil(Number((e.detail as { retryAfterMs: number }).retryAfterMs) / 1000)));
      sendError(res, e);
    } finally {
      metrics.inc("http_requests_total", { status: `${Math.floor(status / 100)}xx` });
      if (process.env.VARIANTSHIELD_LOG !== "off") console.log(JSON.stringify({ t: new Date().toISOString(), rid: requestId, method: req.method, path: url.pathname, status, ms: Date.now() - started }));
    }
  });
  // Slow-client and connection-exhaustion limits (Node defaults are generous).
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 1000;
  return { server, ctx };
}
