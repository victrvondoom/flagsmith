/**
 * CONTRACT DOUBLE, NOT FLAGSMITH.
 * A tiny HTTP server that mimics the Flagsmith endpoints VariantShield uses, built from the response shapes and
 * transition rules in Flagsmith's own source (api/experimentation/*.py, openapi.yaml). Use it for tests and offline
 * development only. Anything that reaches a dashboard through it must be labelled as coming from a double.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

export type FakeStatus = "created" | "running" | "paused" | "completed";
const VALID: Record<FakeStatus, FakeStatus[]> = {
  created: ["running"], running: ["paused", "completed"], paused: ["running", "completed"], completed: [],
};

export interface FakeExperiment {
  id: number; name: string; hypothesis: string; status: FakeStatus; featureName: string; variants: string[];
  weights: Record<string, number>;
}

export interface FakeFlagsmith {
  url: string;
  environmentKey: string;
  adminKey: string;
  experiments: Map<number, FakeExperiment>;
  events: { event: string; identifier: string; value?: unknown; feature_name?: string; timestamp: number }[];
  calls: { method: string; path: string }[];
  results: Map<number, unknown>;
  exposures: Map<number, unknown>;
  /** Fail the next N requests whose path contains `pathIncludes` with `status`. */
  failNext(pathIncludes: string, status: number, times: number, headers?: Record<string, string>): void;
  /** Change the percentage a variant receives, as an operator would in the Flagsmith UI. */
  setWeight(experimentId: number, variant: string, percentage: number): void;
  /** Make the next pause call report success while leaving the experiment running (to test verification). */
  ignoreNextTransition(): void;
  /** Plain flags (environment default plus segment overrides), for incident bisection tests. */
  flags: Map<string, FakeFlag>;
  segments: Map<number, { name: string; percent: number }>;
  audit: { id: number; created_date: string; log: string; related_object_type: string; related_object_id: number; author: { email: string } | null; change_details: { field: string; old: unknown; new: unknown }[] }[];
  /** Changes a flag's environment default as an operator would, writing an audit entry with before/after. */
  changeFlag(name: string, next: { enabled: boolean; value: string | number | boolean | null }, author?: string, atMs?: number): void;
  /** Feature names served to an identity (evaluating canary segment overrides). */
  flagsFor(identifier: string): Record<string, { enabled: boolean; value: string | number | boolean | null }>;
  close(): Promise<void>;
}

export interface FakeFlag { id: number; enabled: boolean; value: string | number | boolean | null; overrides: Map<number, { enabled: boolean; value: string | number | boolean | null; priority: number }> }

export async function startFakeFlagsmith(opts: { experiments?: FakeExperiment[]; pageSize?: number; flags?: Record<string, { enabled: boolean; value: string | number | boolean | null }> } = {}): Promise<FakeFlagsmith> {
  const environmentKey = "ENVKEY_test_0123456789";
  const adminKey = "test-admin-key";
  const experiments = new Map<number, FakeExperiment>((opts.experiments ?? []).map((e) => [e.id, structuredClone(e)]));
  const failures: { includes: string; status: number; left: number; headers: Record<string, string> }[] = [];
  const state = { ignoreTransition: false };
  const self: FakeFlagsmith = {
    url: "", environmentKey, adminKey, experiments, events: [], calls: [], results: new Map(), exposures: new Map(),
    failNext: (includes, status, times, headers = {}) => void failures.push({ includes, status, left: times, headers }),
    ignoreNextTransition: () => { state.ignoreTransition = true; },
    setWeight: (id, variant, percentage) => { const e = experiments.get(id); if (e) e.weights[variant] = percentage / 100; },
    close: () => new Promise((r) => server.close(() => r())),
    flags: new Map(Object.entries(opts.flags ?? {}).map(([name, f], i) => [name, { id: 500 + i, enabled: f.enabled, value: f.value, overrides: new Map() }])),
    segments: new Map(),
    audit: [],
    changeFlag: (name, next, author = "ops@example.com", atMs = Date.now()) => {
      const f = self.flags.get(name);
      if (!f) throw new Error(`no fake flag ${name}`);
      // Same messages and split as Flagsmith (audit/constants.py): one entry for enabled, one for the value.
      if (f.enabled !== next.enabled) self.audit.unshift({ id: self.audit.length + 1, created_date: new Date(atMs).toISOString(), log: `Flag state updated for feature: ${name}`, related_object_type: "FEATURE_STATE", related_object_id: f.id + 1000, author: { email: author }, change_details: [{ field: "enabled", old: f.enabled, new: next.enabled }] });
      if (String(f.value) !== String(next.value)) self.audit.unshift({ id: self.audit.length + 1, created_date: new Date(atMs).toISOString(), log: `Remote config value updated for feature: ${name}`, related_object_type: "FEATURE_STATE", related_object_id: f.id + 1000, author: { email: author }, change_details: [{ field: "string_value", old: f.value, new: next.value }] });
      f.enabled = next.enabled; f.value = next.value;
    },
    flagsFor: (identifier) => {
      const out: Record<string, { enabled: boolean; value: string | number | boolean | null }> = {};
      for (const [name, f] of self.flags) {
        const hit = [...f.overrides.entries()].filter(([seg]) => { const sg = self.segments.get(seg); return sg !== undefined && bucket(identifier, `seg-${seg}`) * 100 < sg.percent; }).sort((a, b) => a[1].priority - b[1].priority)[0];
        out[name] = hit ? { enabled: hit[1].enabled, value: hit[1].value } : { enabled: f.enabled, value: f.value };
      }
      return out;
    },
  };

  const bucket = (identifier: string, feature: string): number => {
    const h = createHash("sha256").update(`${feature}:${identifier}`).digest();
    return h.readUInt32BE(0) / 0xffffffff;
  };
  const assign = (e: FakeExperiment, identifier: string): string => {
    let acc = 0;
    const r = bucket(identifier, e.featureName);
    for (const v of e.variants) {
      acc += e.weights[v] ?? 1 / e.variants.length;
      if (r <= acc) return v;
    }
    return e.variants[e.variants.length - 1]!;
  };
  const view = (e: FakeExperiment): unknown => ({
    id: e.id, name: e.name, hypothesis: e.hypothesis, status: e.status, metrics: [],
    feature: { id: 100 + e.id, name: e.featureName, type: "MULTIVARIATE", initial_value: "control", multivariate_options: e.variants.filter((v) => v !== "control").map((v, i) => ({ id: i + 1, string_value: v })) },
    created_at: "2026-11-20T09:00:00Z", updated_at: "2026-11-20T09:00:00Z", started_at: e.status === "created" ? null : "2026-11-21T09:00:00Z", ended_at: e.status === "completed" ? "2026-11-22T09:00:00Z" : null,
  });

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    return text ? JSON.parse(text) : {};
  };

  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const path = u.pathname;
    self.calls.push({ method: req.method ?? "GET", path });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const failure = failures.find((f) => f.left > 0 && path.includes(f.includes));
    if (failure) { failure.left--; return send(failure.status, { detail: "injected failure" }, failure.headers); }

    const sdk = req.headers["x-environment-key"] === environmentKey;
    const admin = req.headers.authorization === `Api-Key ${adminKey}`;

    if (path === "/api/v1/identities/") {
      if (!sdk) return send(401, { detail: "Invalid environment key" });
      const identifier = u.searchParams.get("identifier") ?? "";
      const flags = [...experiments.values()].filter((e) => e.status === "running").map((e) => ({ feature: { name: e.featureName }, enabled: true, feature_state_value: assign(e, identifier) }));
      const paused = [...experiments.values()].filter((e) => e.status !== "running").map((e) => ({ feature: { name: e.featureName }, enabled: true, feature_state_value: "control" }));
      const plain = Object.entries(self.flagsFor(identifier)).map(([name, v]) => ({ feature: { name }, enabled: v.enabled, feature_state_value: v.value }));
      return send(200, { identifier, flags: [...flags, ...paused.filter((p) => !flags.some((f) => f.feature.name === p.feature.name)), ...plain] });
    }
    // Management endpoints used by getAssignmentConfig (shapes taken from a real Flagsmith response).
    if (path === `/api/v1/environments/${environmentKey}/` && req.method === "GET") {
      if (!admin) return send(req.headers.authorization ? 403 : 401, { detail: "Authentication credentials were not provided." });
      return send(200, { id: 1, name: "Production", project: 1, api_key: environmentKey });
    }
    if (path === "/api/v1/features/featurestates/" && req.method === "GET") {
      if (!admin) return send(req.headers.authorization ? 403 : 401, { detail: "Authentication credentials were not provided." });
      const e = [...experiments.values()].find((x) => String(100 + x.id) === u.searchParams.get("feature"));
      if (!e) return send(200, { count: 0, next: null, previous: null, results: [] });
      const opts = e.variants.filter((v) => v !== "control");
      const mv = (pct: (v: string) => number): unknown[] => opts.map((v, i) => ({ id: i + 1, multivariate_feature_option: i + 1, percentage_allocation: pct(v) }));
      const states: Record<string, unknown>[] = [{ id: 1, enabled: true, feature: 100 + e.id, feature_segment: null, feature_state_value: { type: "unicode", string_value: "control" }, multivariate_feature_state_values: mv(() => 0) }];
      if (e.status !== "created") states.push({ id: 2, enabled: true, feature: 100 + e.id, feature_segment: 1, feature_state_value: { type: "unicode", string_value: "control" }, multivariate_feature_state_values: mv((v) => Math.round((e.weights[v] ?? 0) * 1000) / 10) });
      return send(200, { count: states.length, next: null, previous: null, results: states });
    }
    // Environment default feature states (accepts feature_name, like Flagsmith's /environments/{key}/featurestates/).
    if (path === `/api/v1/environments/${environmentKey}/featurestates/` && req.method === "GET") {
      if (!admin) return send(req.headers.authorization ? 403 : 401, { detail: "Authentication credentials were not provided." });
      const name = u.searchParams.get("feature_name");
      const e = [...experiments.values()].find((x) => x.featureName === name);
      const f = name ? self.flags.get(name) : undefined;
      const results = e ? [{ id: 1, feature: 100 + e.id, enabled: true }] : f ? [{ id: f.id + 1000, feature: f.id, enabled: f.enabled }] : [];
      return send(200, { count: results.length, next: null, previous: null, results });
    }
    if (path === "/api/v1/projects/1/features/" && req.method === "GET") {
      if (!admin) return send(401, { detail: "Authentication credentials were not provided." });
      const q = u.searchParams.get("search") ?? "";
      const all = [...[...experiments.values()].map((e) => ({ id: 100 + e.id, name: e.featureName })), ...[...self.flags.entries()].map(([name, f]) => ({ id: f.id, name }))].filter((x) => x.name.includes(q));
      return send(200, { count: all.length, next: null, previous: null, results: all });
    }
    const ff = path.match(/^\/api\/__future__\/environments\/([^/]+)\/features\/(\d+)\/(?:segment-overrides\/(\d+)\/)?$/);
    if (ff) {
      if (!admin) return send(401, { detail: "Authentication credentials were not provided." });
      if (ff[1] !== environmentKey) return send(404, { detail: "Not found." });
      const entry = [...self.flags.entries()].find(([, f]) => f.id === Number(ff[2]));
      if (!entry) return send(404, { detail: "Not found." });
      const [name, f] = entry;
      const typed = (v: string | number | boolean | null): unknown => (v === null ? null : { type: typeof v === "boolean" ? "boolean" : typeof v === "number" ? "integer" : "string", value: String(v) });
      const untyped = (v: { type?: string; value?: string } | null | undefined): string | number | boolean | null => (v == null ? null : v.type === "boolean" ? v.value === "true" : v.type === "integer" ? Number(v.value) : String(v.value));
      const view2 = (): unknown => ({ environment_default: { enabled: f.enabled, value: typed(f.value), variants: [] }, segment_overrides: [...f.overrides.entries()].map(([seg, o]) => ({ segment: { id: seg }, priority: o.priority, enabled: o.enabled, value: typed(o.value), variants: [] })) });
      if (ff[3]) {
        if (req.method !== "DELETE") return send(405, { detail: "Method not allowed" });
        if (!f.overrides.delete(Number(ff[3]))) return send(404, { detail: "Not found." });
        return send(200, view2());
      }
      if (req.method === "GET") return send(200, view2());
      if (req.method === "PATCH") {
        const b = (await readBody(req)) as { environment_default?: { enabled?: boolean; value?: { type?: string; value?: string } | null }; segment_overrides?: { segment: { id: number }; priority?: number; enabled?: boolean; value?: { type?: string; value?: string } | null }[] };
        if (b.environment_default) {
          const next = { enabled: b.environment_default.enabled ?? f.enabled, value: b.environment_default.value === undefined ? f.value : untyped(b.environment_default.value) };
          self.changeFlag(name, next, "variantshield-api-key");
        }
        for (const o of b.segment_overrides ?? []) {
          if (!self.segments.has(o.segment.id)) return send(400, { segment_overrides: [{ segment: { id: ["Segment not found."] } }] });
          const prev = f.overrides.get(o.segment.id);
          f.overrides.set(o.segment.id, { enabled: o.enabled ?? prev?.enabled ?? f.enabled, value: o.value === undefined ? (prev?.value ?? f.value) : untyped(o.value), priority: o.priority ?? prev?.priority ?? 0 });
        }
        return send(200, view2());
      }
      return send(405, { detail: "Method not allowed" });
    }
    if (path === "/api/v1/projects/1/segments/" && req.method === "POST") {
      if (!admin) return send(401, { detail: "Authentication credentials were not provided." });
      const b = (await readBody(req)) as { name?: string; rules?: { rules?: { conditions?: { operator?: string; value?: string }[] }[] }[] };
      const cond = b.rules?.[0]?.rules?.[0]?.conditions?.[0];
      if (cond?.operator !== "PERCENTAGE_SPLIT") return send(400, { rules: ["fake supports PERCENTAGE_SPLIT only"] });
      if (!(cond as { property?: string }).property) return send(400, { rules: [{ rules: [{ conditions: [{ property: ["This field may not be blank."] }] }] }] }); // as Flagsmith's serializer
      const id = 900 + self.segments.size;
      self.segments.set(id, { name: String(b.name), percent: Number(cond.value) });
      return send(201, { id, name: b.name, project: 1 });
    }
    const sm = path.match(/^\/api\/v1\/projects\/1\/segments\/(\d+)\/$/);
    if (sm && req.method === "DELETE") {
      if (!admin) return send(401, { detail: "Authentication credentials were not provided." });
      const id = Number(sm[1]);
      if (!self.segments.delete(id)) return send(404, { detail: "Not found." });
      for (const f of self.flags.values()) f.overrides.delete(id);
      return res.writeHead(204).end();
    }
    if (path === "/api/v1/projects/1/audit/" && req.method === "GET") {
      if (!admin) return send(401, { detail: "Authentication credentials were not provided." });
      const results = self.audit.map(({ change_details: _c, ...rest }) => rest);
      return send(200, { count: results.length, next: null, previous: null, results });
    }
    const am = path.match(/^\/api\/v1\/projects\/1\/audit\/(\d+)\/$/);
    if (am && req.method === "GET") {
      const a = self.audit.find((x) => x.id === Number(am[1]));
      if (!a) return send(404, { detail: "Not found." });
      return send(200, { ...a, change_type: a.change_details.length ? "UPDATE" : "UNKNOWN" });
    }
    const pm = path.match(/^\/api\/v1\/projects\/1\/features\/(\d+)\/$/);
    if (pm && req.method === "GET") {
      if (!admin) return send(req.headers.authorization ? 403 : 401, { detail: "Authentication credentials were not provided." });
      const e = [...experiments.values()].find((x) => 100 + x.id === Number(pm[1]));
      if (!e) return send(404, { detail: "Not found." });
      return send(200, { id: 100 + e.id, name: e.featureName, type: "MULTIVARIATE", multivariate_options: e.variants.filter((v) => v !== "control").map((v, i) => ({ id: i + 1, type: "unicode", string_value: v })) });
    }
    if (path === "/api/v1/flags/" && req.method === "GET") {
      if (!sdk) return send(401, { detail: "Invalid environment key" });
      return send(200, [...self.flags.entries()].map(([name, f]) => ({ id: f.id + 1000, feature: { id: f.id, name }, enabled: f.enabled, feature_state_value: f.value, environment: 1, identity: null, feature_segment: null })));
    }
    if (path === "/api/v1/events/" && req.method === "POST") {
      if (!sdk) return send(401, { detail: "Invalid environment key" });
      const body = (await readBody(req)) as { events?: FakeFlagsmith["events"] };
      if (!Array.isArray(body.events) || body.events.length === 0) return send(400, { events: ["events must be non-empty"] });
      self.events.push(...body.events);
      return res.writeHead(204).end();
    }

    const m = path.match(/^\/api\/v1\/environments\/([^/]+)\/experiments\/(?:(\d+)\/(?:(start|pause|complete|results|exposures|results\/refresh|exposures\/refresh)\/)?)?$/);
    if (!m) return send(404, { detail: "Not found." });
    if (!admin) return send(req.headers.authorization ? 403 : 401, { detail: "Authentication credentials were not provided." });
    if (m[1] !== environmentKey) return send(404, { detail: "Not found." });
    if (!m[2]) {
      const all = [...experiments.values()].filter((e) => !u.searchParams.get("status") || e.status === u.searchParams.get("status"));
      const size = opts.pageSize ?? 100;
      const page = Number(u.searchParams.get("page") ?? 1);
      const slice = all.slice((page - 1) * size, page * size);
      const next = page * size < all.length ? `${self.url}${path}?page=${page + 1}` : null;
      return send(200, { count: all.length, next, previous: null, results: slice.map(view) });
    }
    const e = experiments.get(Number(m[2]));
    if (!e) return send(404, { detail: "Not found." });
    const action = m[3];
    if (!action) return send(200, view(e));
    if (action === "results/refresh" || action === "exposures/refresh") return res.writeHead(202).end();
    if (action === "results") return send(200, { results: self.results.has(e.id) ? { as_of: "2026-11-23T00:00:00Z", is_final: false, last_error_at: null, payload: self.results.get(e.id) } : null });
    if (action === "exposures") return send(200, { exposures: self.exposures.has(e.id) ? { as_of: "2026-11-23T00:00:00Z", is_final: false, last_error_at: null, payload: self.exposures.get(e.id) } : null });
    const target: FakeStatus = action === "start" ? "running" : action === "pause" ? "paused" : "completed";
    if (!VALID[e.status].includes(target)) return send(400, { detail: "Unable to transition experiment status." });
    if (state.ignoreTransition) { state.ignoreTransition = false; return send(200, view(e)); }
    e.status = target;
    return send(200, view(e));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  self.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return self;
}

export const SAMPLE_EXPERIMENT: FakeExperiment = {
  id: 7, name: "Checkout flow", hypothesis: "UPI-first checkout increases completion", status: "running",
  featureName: "checkout_flow", variants: ["control", "upi_first", "one_tap"], weights: { control: 1 / 3, upi_first: 1 / 3, one_tap: 1 / 3 },
};

/** Results payload in the real ResultsSummary shape (experimentation/dataclasses.py). */
export function sampleResultsPayload(over: { winner?: string | null; n?: number } = {}): unknown {
  const n = over.n ?? 1200;
  const winner = over.winner === undefined ? "upi_first" : over.winner;
  const conv = (rate: number): { n: number; sum: number; sum_squares: number } => ({ n, sum: Math.round(n * rate), sum_squares: Math.round(n * rate) });
  return {
    srm_p_value: 0.8,
    metrics: [{
      metric_id: 1,
      variants: { control: conv(0.3), upi_first: conv(winner === "upi_first" ? 0.36 : 0.3), one_tap: conv(0.31) },
      inference: {
        upi_first: winner === "upi_first" ? { lift: 0.2, ci_low: 0.05, ci_high: 0.35, chance_to_win: 0.99 } : { lift: 0, ci_low: -0.1, ci_high: 0.1, chance_to_win: 0.5 },
        one_tap: { lift: 0.03, ci_low: -0.08, ci_high: 0.14, chance_to_win: 0.7 },
      },
      conversions_timeseries: null,
    }],
    exposures_timeseries: { granularity: "hour", points: [] },
  };
}
