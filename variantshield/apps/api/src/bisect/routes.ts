import { createHmac, timingSafeEqual } from "node:crypto";
import type { Route } from "../app.ts";
import { HttpError, readRaw } from "../http.ts";
import { AGENTS, type BisectRuntime, type Source, type SwarmEvent } from "./runtime.ts";
import { SIM_SCENARIOS, type Flags, type Signal } from "./control.ts";
import { changeFromWebhook } from "./flagsmith-control.ts";
import type { Ctx } from "../context.ts";

const obj = (b: unknown): Record<string, unknown> => { if (typeof b !== "object" || b === null || Array.isArray(b)) throw new HttpError(400, "invalid_body", "Body must be a JSON object"); return b as Record<string, unknown>; };
const rt = (ctx: Ctx): BisectRuntime => { if (!ctx.bisect) throw new HttpError(503, "bisect_unavailable", "Incident bisection is not running"); return ctx.bisect; };
const idParam = (v: string | undefined): number => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "validation_failed", "id must be a positive integer"); return n; };
const MAX_SIGNALS = 1000;

/** Validates app-reported signals: opaque identity, outcome, and the flags the app was actually served. */
export function parseSignals(raw: unknown, nowMs: number): Signal[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SIGNALS) throw new HttpError(400, "validation_failed", `signals must be an array of 1 to ${MAX_SIGNALS} items`);
  return raw.map((x, i) => {
    const s = obj(x);
    if (typeof s.identity !== "string" || !/^[\w.:@-]{1,128}$/.test(s.identity)) throw new HttpError(400, "validation_failed", `signals[${i}].identity must be an opaque id (letters, digits, . : @ - _), at most 128 characters`);
    if (typeof s.ok !== "boolean") throw new HttpError(400, "validation_failed", `signals[${i}].ok must be true or false`);
    const ts = s.ts === undefined ? nowMs : Number(s.ts);
    if (!Number.isFinite(ts) || ts > nowMs + 60_000 || ts < nowMs - 86_400_000) throw new HttpError(400, "validation_failed", `signals[${i}].ts must be within the last 24 hours`);
    const f = obj(s.flags);
    const keys = Object.keys(f);
    if (keys.length === 0 || keys.length > 100) throw new HttpError(400, "validation_failed", `signals[${i}].flags must name 1 to 100 flags`);
    const flags: Flags = {};
    for (const k of keys) {
      if (!/^[\w.-]{1,150}$/.test(k)) throw new HttpError(400, "validation_failed", `signals[${i}].flags has an invalid feature name`);
      const v = obj(f[k]);
      if (typeof v.enabled !== "boolean") throw new HttpError(400, "validation_failed", `signals[${i}].flags.${k}.enabled must be a boolean`);
      const val = v.value ?? null;
      if (val !== null && typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") throw new HttpError(400, "validation_failed", `signals[${i}].flags.${k}.value must be a string, number, boolean or null`);
      if (typeof val === "string" && val.length > 200) throw new HttpError(400, "validation_failed", `signals[${i}].flags.${k}.value is too long`);
      flags[k] = { enabled: v.enabled, value: val };
    }
    return { ts, identity: s.identity, ok: s.ok, flags };
  });
}

export function verifyFlagsmithSignature(secret: string, raw: Buffer, given: unknown): boolean {
  if (typeof given !== "string" || !/^[0-9a-f]{64}$/.test(given)) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"));
  return timingSafeEqual(want, Buffer.from(given));
}

export const bisectRoutes: Route[] = [
  { method: "GET", pattern: /^\/api\/swarm$/, auth: "admin", handler: ({ ctx }) => ({ agents: AGENTS, scenarios: SIM_SCENARIOS.map(({ id, title, description, changes }) => ({ id, title, description, changes: changes.length })), demoMode: ctx.cfg.demoMode, flagsmith: ctx.bisect?.real ? ctx.bisect.real.describe() : null, simulation: ctx.bisect?.sim ? { ...ctx.bisect.sim.describe(), clock: ctx.bisect.sim.clock } : null, webhook: { path: "/api/flagsmith/webhook", secretConfigured: ctx.cfg.flagsmithWebhookSecret !== null } }) },
  {
    method: "GET", pattern: /^\/api\/incidents$/, auth: "admin",
    handler: ({ ctx, query }) => { const s = query.get("source"); if (s && s !== "real" && s !== "simulation") throw new HttpError(400, "validation_failed", 'source must be "real" or "simulation"'); return { incidents: rt(ctx).list((s ?? undefined) as Source | undefined) }; },
  },
  { method: "GET", pattern: /^\/api\/incidents\/(\d+)$/, auth: "admin", handler: ({ ctx, params }) => ({ incident: rt(ctx).view(idParam(params[0])) }) },
  {
    method: "POST", pattern: /^\/api\/incidents\/simulate$/, auth: "admin",
    handler: async ({ ctx, body }) => {
      if (!ctx.cfg.demoMode) throw new HttpError(403, "demo_disabled", "Simulation is disabled (VARIANTSHIELD_DEMO_MODE=false)");
      const b = obj(await body());
      return { started: rt(ctx).startSimulation(String(b.scenario ?? ""), Number.isInteger(b.seed) ? Number(b.seed) : 7), label: "SIMULATION: in-process flags and synthetic traffic; nothing is sent to Flagsmith" };
    },
  },
  {
    method: "POST", pattern: /^\/api\/incidents\/(\d+)\/envelope$/, auth: "admin",
    handler: async ({ ctx, params, body, actor }) => {
      const b = obj(await body()), id = idParam(params[0]);
      rt(ctx).approveEnvelope(id, actor, b.confirmation, b.reason, {
        ...(b.canaryPercent !== undefined ? { canaryPercent: Number(b.canaryPercent) } : {}), ...(b.maxRounds !== undefined ? { maxRounds: Number(b.maxRounds) } : {}), ...(b.maxMinutes !== undefined ? { maxMinutes: Number(b.maxMinutes) } : {}),
      });
      return { incident: rt(ctx).view(id) };
    },
  },
  { method: "POST", pattern: /^\/api\/incidents\/(\d+)\/abort$/, auth: "admin", handler: async ({ ctx, params, body, actor }) => { const id = idParam(params[0]); await rt(ctx).abort(id, actor, obj(await body()).reason); return { incident: rt(ctx).view(id) }; } },
  {
    method: "POST", pattern: /^\/api\/incidents\/(\d+)\/remediation$/, auth: "admin",
    handler: async ({ ctx, params, body, actor }) => {
      const b = obj(await body()), id = idParam(params[0]);
      if (b.action === "propose") rt(ctx).proposeRemediation(id, actor, b.reason);
      else if (b.action === "approve") await rt(ctx).approveRemediation(id, actor, b.confirmation, b.reason);
      else throw new HttpError(400, "validation_failed", 'action must be "propose" or "approve"');
      return { incident: rt(ctx).view(id) };
    },
  },
  {
    // Apps report outcomes together with the flags they were served (the cohort is read from these, never guessed).
    method: "POST", pattern: /^\/api\/bisect\/signals$/, auth: "ingest",
    handler: async ({ ctx, body, charge }) => {
      const signals = parseSignals(obj(await body()).signals, ctx.now());
      charge(signals.length);
      return { stored: rt(ctx).storeSignals("real", signals) };
    },
  },
  {
    // Flagsmith environment webhook (FLAG_UPDATED). Public route: authenticity comes from X-Flagsmith-Signature.
    method: "POST", pattern: /^\/api\/flagsmith\/webhook$/, auth: "public",
    handler: async ({ ctx, req }) => {
      const secret = ctx.cfg.flagsmithWebhookSecret;
      if (!secret) throw new HttpError(404, "not_found", "Not found");
      const raw = await readRaw(req);
      if (!verifyFlagsmithSignature(secret, raw, req.headers["x-flagsmith-signature"])) throw new HttpError(401, "invalid_signature", "X-Flagsmith-Signature does not match");
      let body: unknown;
      try { body = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "invalid_json", "Request body is not valid JSON"); }
      const c = changeFromWebhook(body);
      if (!c) return { recorded: false };
      ctx.db.run("INSERT INTO flag_changes (received_at, changed_at, feature, feature_id, before, after, changed_by, source) VALUES (?,?,?,?,?,?,?,?)", ctx.now(), c.changedAt, c.feature, c.featureId, JSON.stringify(c.before), JSON.stringify(c.after), c.changedBy, "webhook");
      return { recorded: true, feature: c.feature };
    },
  },
  {
    // Live updates. EventSource cannot send Authorization, so the dashboard reads this with fetch() and a stream reader.
    method: "GET", pattern: /^\/api\/stream$/, auth: "admin", raw: true,
    handler: ({ ctx, req, res }) => {
      const runtime = rt(ctx);
      const want = Number(req.url?.match(/incident=(\d+)/)?.[1] ?? 0);
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(`event: hello\ndata: ${JSON.stringify({ at: ctx.now() })}\n\n`);
      let pending = false;
      const send = (e: SwarmEvent): void => {
        if (want && e.incidentId !== null && e.incidentId !== want) return;
        if (e.type === "tick") { if (pending) return; pending = true; setTimeout(() => { pending = false; res.write(`event: tick\ndata: ${JSON.stringify({ source: e.source, data: e.data })}\n\n`); }, 500); return; }
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      runtime.bus.on("event", send);
      const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
      req.socket.setTimeout(0);
      res.on("close", () => { clearInterval(beat); runtime.bus.off("event", send); });
    },
  },
];
