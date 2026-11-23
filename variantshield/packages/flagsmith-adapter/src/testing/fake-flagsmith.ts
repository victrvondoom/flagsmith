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
  /** Make the next pause call report success while leaving the experiment running (to test verification). */
  ignoreNextTransition(): void;
  close(): Promise<void>;
}

export async function startFakeFlagsmith(opts: { experiments?: FakeExperiment[]; pageSize?: number } = {}): Promise<FakeFlagsmith> {
  const environmentKey = "ENVKEY_test_0123456789";
  const adminKey = "test-admin-key";
  const experiments = new Map<number, FakeExperiment>((opts.experiments ?? []).map((e) => [e.id, structuredClone(e)]));
  const failures: { includes: string; status: number; left: number; headers: Record<string, string> }[] = [];
  const state = { ignoreTransition: false };
  const self: FakeFlagsmith = {
    url: "", environmentKey, adminKey, experiments, events: [], calls: [], results: new Map(), exposures: new Map(),
    failNext: (includes, status, times, headers = {}) => void failures.push({ includes, status, left: times, headers }),
    ignoreNextTransition: () => { state.ignoreTransition = true; },
    close: () => new Promise((r) => server.close(() => r())),
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
      return send(200, { identifier, flags: [...flags, ...paused.filter((p) => !flags.some((f) => f.feature.name === p.feature.name))] });
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
